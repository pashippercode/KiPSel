from __future__ import annotations

import asyncio
import contextlib
import re
from typing import Any, Mapping

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.components import Image
from astrbot.core.platform.message_type import MessageType
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

from .client import ControllerClient, ControllerClientError
from .media import MediaInputError, image_payload
from .queueing import (
    MemoryJobQueues,
    QueueError,
    QueuedJob,
    command_tail,
    command_words,
    parse_optional_alias,
    parse_start_args,
    parse_stop_args,
    require_name,
)


MAX_TEXT_CHARS = 100_000
MAX_IMAGE_COUNT = 3
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024

LIVE_STATUSES = frozenset({"starting", "running", "stale"})
SWEEP_INTERVAL_SECONDS = 60
RETRY_DELAY_SECONDS = 3
MAX_RETRIES = 20

_USAGE = (
    "KiPSel 用法（仅 ADMIN 私聊）\n"
    "/pi start <alias> [project] [profile]\n"
    "/pi stop [alias] [force]\n"
    "/pi list\n"
    "/pi use <alias>\n"
    "/pi ask [提示词]（可附图，≤3 张）\n"
    "/pi queue [alias]\n"
    "/pi cancel <job-id|all>\n"
    "/pi abort [alias]"
)

_ERROR_MESSAGES = {
    "queue-full": "该会话排队已满，请稍后再试",
    "controller-unavailable": "controller 不可达",
    "session-not-found": "会话不存在或未运行",
    "vision-required": "当前会话 profile 不支持图片",
    "invalid-alias": "alias 不合法（字母或数字开头，≤32 位）",
    "invalid-project": "project 不在白名单内",
    "invalid-profile": "profile 不在白名单内",
    "session-limit": "会话数量已达上限",
    "session-conflict": "该 alias 已绑定其他 project/profile",
    "session-busy": "会话仍有排队或活动任务；可用 /pi stop <alias> force 强制停止",
    "no-alias-selected": "请先 /pi use <alias> 选择会话",
    "invalid-job-id": "任务 ID 不合法",
    "job-not-found": "任务不存在或已结束",
    "invalid-image": "图片无法读取",
    "image-too-large": "单张图片超过 5 MiB",
    "unsupported-image": "仅支持 JPEG/PNG/WebP/GIF 图片",
    "image-download-failed": "图片下载失败",
    "image-download-unavailable": "图片下载组件不可用",
    "unauthorized": "controller 凭据校验失败",
    "forbidden": "controller 拒绝了来源地址",
    "usage-start": "用法：/pi start <alias> [project] [profile]",
    "usage-stop": "用法：/pi stop [alias] [force]",
    "usage-queue": "用法：/pi queue [alias]",
    "usage-abort": "用法：/pi abort [alias]",
    "usage-cancel": "用法：/pi cancel <job-id|all>",
    "usage-use": "用法：/pi use <alias>",
    "job-wait-timeout": "任务等待结果超时",
    "extension-unresponsive": "TUI 扩展失去响应",
}


def _error_message(code: str) -> str:
    if code in _ERROR_MESSAGES:
        return _ERROR_MESSAGES[code]
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(code))[:64] or "unknown"
    return f"操作失败：{safe}"


@register(
    "astrbot_plugin_kipsel",
    "KiPSel contributors",
    "由 AstrBot ADMIN 私聊管理本机可见 pi TUI 会话",
    "0.1.0",
)
class KiPSelPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None) -> None:
        super().__init__(context)
        self._config: Mapping[str, Any] = config or {}
        self._queues = MemoryJobQueues(
            max_per_alias=int(self._config.get("queue_limit_per_alias") or 20),
            ttl_seconds=int(self._config.get("queue_ttl_minutes") or 30) * 60,
        )
        self._controller: ControllerClient | None = None
        self._workers: dict[str, asyncio.Task] = {}
        self._selected: dict[str, str] = {}
        self._sweeper_task: asyncio.Task | None = None
        self._terminated = False

    def _client(self) -> ControllerClient:
        if self._controller is None:
            self._controller = ControllerClient(
                str(self._config.get("controller_url") or ""),
                str(self._config.get("controller_bearer") or ""),
            )
        return self._controller

    async def _notify(self, job: QueuedJob, text: str) -> None:
        if not job.unified_msg_origin:
            return
        try:
            await self.context.send_message(
                job.unified_msg_origin, MessageChain().message(text)
            )
        except Exception:
            logger.warning("KiPSel notify failed")

    @filter.command("pi")
    async def pi(self, event: AstrMessageEvent):
        if not event.is_admin() or event.get_message_type() != MessageType.FRIEND_MESSAGE:
            yield event.plain_result("KiPSel 仅允许 ADMIN 私聊使用")
            return
        self._ensure_sweeper()
        raw = event.get_message_str()
        match = re.match(r"^\s*/?pi(?:\s+(\S+))?", raw)
        sub = (match.group(1) or "").lower() if match else ""
        handler = {
            "start": self._cmd_start,
            "stop": self._cmd_stop,
            "list": self._cmd_list,
            "use": self._cmd_use,
            "ask": self._cmd_ask,
            "queue": self._cmd_queue,
            "cancel": self._cmd_cancel,
            "abort": self._cmd_abort,
        }.get(sub)
        if handler is None:
            yield event.plain_result(_USAGE)
            return
        async for result in handler(event, raw):
            yield result

    async def _cmd_start(self, event: AstrMessageEvent, raw: str):
        try:
            alias, project, profile = parse_start_args(raw)
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            session = await client.start_session(alias, project=project, profile=profile)
        except ControllerClientError as error:
            logger.warning(f"KiPSel start failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        yield event.plain_result(
            f"会话 {session.get('alias', alias)} 已启动"
            f"（profile={session.get('profile', '?')}，status={session.get('status', '?')}）"
        )

    async def _cmd_stop(self, event: AstrMessageEvent, raw: str):
        selected = self._selected.get(event.unified_msg_origin)
        try:
            alias, force = parse_stop_args(raw, selected)
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            session = await client.stop_session(alias, force=force)
        except ControllerClientError as error:
            logger.warning(f"KiPSel stop failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        note = ""
        if force:
            cancelled = self._queues.cancel_queued(alias, "all")
            for job in cancelled:
                await self._notify(job, f"任务 #{job.public_id} 已随会话强制停止而取消")
            if cancelled:
                note = f"，本地等待任务已取消 {len(cancelled)} 个"
        yield event.plain_result(
            f"会话 {alias} 已停止（status={session.get('status', 'stopped')}）{note}"
        )

    async def _cmd_list(self, event: AstrMessageEvent, raw: str):
        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            sessions = await client.sessions()
        except ControllerClientError as error:
            logger.warning(f"KiPSel list failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        if not sessions:
            yield event.plain_result("当前没有 KiPSel 会话")
            return
        lines = []
        for session in sessions:
            alias = str(session.get("alias", "?"))
            queue = session.get("queue") or {}
            waiting = self._queues.waiting_count(alias)
            lines.append(
                f"{alias} status={session.get('status', '?')}"
                f" profile={session.get('profile', '?')}"
                f" project={session.get('project') or '?'}"
                f" 排队={int(queue.get('queued', 0)) + waiting}"
                f" 活动={queue.get('active', 0)}"
            )
        yield event.plain_result("KiPSel 会话：\n" + "\n".join(lines))

    async def _cmd_use(self, event: AstrMessageEvent, raw: str):
        try:
            words = command_words(raw, "use")
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        if len(words) != 1:
            yield event.plain_result(_error_message("usage-use"))
            return
        try:
            alias = require_name(words[0], "alias")
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            sessions = await client.sessions()
        except ControllerClientError as error:
            logger.warning(f"KiPSel use failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        live = any(
            s.get("alias") == alias and s.get("status") in LIVE_STATUSES for s in sessions
        )
        if not live:
            yield event.plain_result("会话不存在或未运行")
            return
        self._selected[event.unified_msg_origin] = alias
        yield event.plain_result(f"已选择会话 {alias}")

    async def _cmd_ask(self, event: AstrMessageEvent, raw: str):
        alias = self._selected.get(event.unified_msg_origin)
        if not alias:
            yield event.plain_result(_error_message("no-alias-selected"))
            return
        try:
            text = command_tail(raw, "ask")
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return

        image_sources: list[str] = []
        for component in event.get_messages():
            if isinstance(component, Image):
                source = component.file or component.url or component.path
                if not source:
                    yield event.plain_result(_error_message("invalid-image"))
                    return
                image_sources.append(source)

        if len(text) > MAX_TEXT_CHARS:
            yield event.plain_result("提示词过长（上限 100k 字符）")
            return
        if len(image_sources) > MAX_IMAGE_COUNT:
            yield event.plain_result(f"图片最多 {MAX_IMAGE_COUNT} 张")
            return
        if not text.strip() and not image_sources:
            yield event.plain_result("请提供提示词或图片")
            return

        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            sessions = await client.sessions()
        except ControllerClientError as error:
            logger.warning(f"KiPSel ask session check failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        session = next(
            (
                s
                for s in sessions
                if s.get("alias") == alias and s.get("status") in LIVE_STATUSES
            ),
            None,
        )
        if session is None:
            yield event.plain_result("会话不存在或未运行")
            return
        if image_sources:
            try:
                projects = await client.projects()
            except ControllerClientError as error:
                logger.warning(f"KiPSel ask profile check failed: {error.code}")
                yield event.plain_result(_error_message(error.code))
                return
            profiles = {
                p.get("name"): p
                for p in projects.get("profiles", [])
                if isinstance(p, Mapping)
            }
            if not (profiles.get(session.get("profile")) or {}).get("vision"):
                yield event.plain_result(_error_message("vision-required"))
                return

        # 会话与 profile 校验通过后才下载/读取图片，避免无谓的流量与内存占用。
        images: list[dict[str, str]] = []
        try:
            file_root = str(get_astrbot_data_path())
            for source in image_sources:
                images.append(
                    await image_payload(
                        source, max_bytes=MAX_IMAGE_BYTES, allowed_file_root=file_root
                    )
                )
        except MediaInputError as error:
            yield event.plain_result(_error_message(error.code))
            return
        total_bytes = sum(len(item["data"]) * 3 // 4 for item in images)
        if total_bytes > MAX_IMAGE_TOTAL_BYTES:
            yield event.plain_result("图片总大小超过 8 MiB")
            return

        try:
            job = self._queues.enqueue(
                alias=alias,
                unified_msg_origin=event.unified_msg_origin,
                text=text,
                images=images,
            )
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        self._ensure_worker(alias)
        waiting = self._queues.waiting_count(alias)
        yield event.plain_result(f"已排队 #{job.public_id}（会话 {alias}，等待 {waiting} 个）")

    async def _cmd_queue(self, event: AstrMessageEvent, raw: str):
        selected = self._selected.get(event.unified_msg_origin)
        try:
            alias = parse_optional_alias(raw, "queue", selected)
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        entries = self._queues.entries(alias)
        if not entries:
            yield event.plain_result(f"会话 {alias} 没有排队或活动任务")
            return
        lines = [f"#{entry.public_id} {entry.state} {entry.age_seconds}s" for entry in entries]
        yield event.plain_result(f"会话 {alias} 队列：\n" + "\n".join(lines))

    async def _cmd_cancel(self, event: AstrMessageEvent, raw: str):
        alias = self._selected.get(event.unified_msg_origin)
        if not alias:
            yield event.plain_result(_error_message("no-alias-selected"))
            return
        try:
            words = command_words(raw, "cancel")
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        if len(words) != 1:
            yield event.plain_result(_error_message("usage-cancel"))
            return
        selector = words[0]
        try:
            cancelled = self._queues.cancel_queued(alias, selector)
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        for job in cancelled:
            await self._notify(job, f"任务 #{job.public_id} 已取消")

        active_requested = False
        active = self._queues.active(alias)
        if active and (selector.lower() == "all" or active.public_id.lower() == selector.lower()):
            client = self._client_or_reply()
            if client is not None:
                try:
                    await client.cancel_job(active.request_id)
                    active_requested = True
                except ControllerClientError as error:
                    logger.warning(f"KiPSel cancel active failed: {error.code}")
        note = f"已取消 {len(cancelled)} 个等待任务"
        if active_requested:
            note += "，并已请求取消当前活动任务"
        yield event.plain_result(note)

    async def _cmd_abort(self, event: AstrMessageEvent, raw: str):
        selected = self._selected.get(event.unified_msg_origin)
        try:
            alias = parse_optional_alias(raw, "abort", selected)
        except QueueError as error:
            yield event.plain_result(_error_message(error.code))
            return
        client = self._client_or_reply()
        if client is None:
            yield event.plain_result("KiPSel controller 配置缺失或非法")
            return
        try:
            await client.abort_session(alias)
        except ControllerClientError as error:
            logger.warning(f"KiPSel abort failed: {error.code}")
            yield event.plain_result(_error_message(error.code))
            return
        yield event.plain_result("已请求中断当前任务")

    def _client_or_reply(self) -> ControllerClient | None:
        try:
            return self._client()
        except ValueError:
            return None

    def _ensure_worker(self, alias: str) -> None:
        if self._terminated:
            return
        task = self._workers.get(alias)
        if task is None or task.done():
            self._workers[alias] = asyncio.create_task(self._worker(alias))

    async def _worker(self, alias: str) -> None:
        try:
            while True:
                take = self._queues.take_next(alias)
                for expired in take.expired:
                    await self._notify(expired, f"任务 #{expired.public_id} 已过期丢弃")
                job = take.job
                if job is None:
                    return
                await self._run_job(job)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error(f"KiPSel worker crashed: {type(error).__name__}")
        finally:
            self._workers.pop(alias, None)

    async def _run_job(self, job: QueuedJob) -> None:
        try:
            await self._run_job_inner(job)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error(f"KiPSel job crashed: {type(error).__name__}")
            await self._notify(job, f"任务 #{job.public_id} 失败：内部错误")
        finally:
            # 任何路径都必须释放 active 槽位，否则该 alias 队列会永久卡死。
            self._queues.finish(job)

    async def _run_job_inner(self, job: QueuedJob) -> None:
        client = self._client_or_reply()
        if client is None:
            await self._notify(job, f"任务 #{job.public_id} 提交失败：controller 配置缺失")
            return

        attempts = 0
        while True:
            try:
                await client.submit_job(
                    request_id=job.request_id,
                    alias=job.alias,
                    text=job.text,
                    images=job.images,
                )
                job.controller_submitted = True
                job.release_input()
                break
            except ControllerClientError as error:
                attempts += 1
                if (
                    error.retryable
                    and attempts < MAX_RETRIES
                    and not job.cancel_requested
                    and not self._queues.is_expired(job)
                ):
                    logger.warning(f"KiPSel submit retry: {error.code}")
                    await asyncio.sleep(RETRY_DELAY_SECONDS)
                    continue
                logger.warning(f"KiPSel submit failed: {error.code}")
                await self._notify(
                    job, f"任务 #{job.public_id} 提交失败：{_error_message(error.code)}"
                )
                return

        max_wait = float(self._config.get("max_job_wait_minutes") or 120) * 60
        attempts = 0
        while True:
            try:
                result = await client.wait_for_job(job.request_id, max_seconds=max_wait)
                break
            except ControllerClientError as error:
                attempts += 1
                if error.retryable and attempts < MAX_RETRIES:
                    await asyncio.sleep(RETRY_DELAY_SECONDS)
                    continue
                logger.warning(f"KiPSel wait failed: {error.code}")
                await self._notify(
                    job, f"任务 #{job.public_id} 失败：{_error_message(error.code)}"
                )
                return

        status = result.get("status")
        if status == "completed":
            text = str(result.get("resultText") or "") or "(无文本输出)"
            if result.get("interrupted"):
                text += "\n（已被打断，结果可能不完整）"
            chain = MessageChain().message(f"〖{job.alias} #{job.public_id}〗\n{text}")
            try:
                await self.context.send_message(job.unified_msg_origin, chain)
            except Exception:
                logger.warning("KiPSel result delivery failed")
        elif status == "cancelled":
            await self._notify(job, f"任务 #{job.public_id} 已取消")
        else:
            code = re.sub(r"[^A-Za-z0-9_-]", "", str(result.get("errorCode") or ""))[:64]
            await self._notify(job, f"任务 #{job.public_id} 失败：{code or 'job-failed'}")

    def _ensure_sweeper(self) -> None:
        if self._terminated:
            return
        if self._sweeper_task is None or self._sweeper_task.done():
            self._sweeper_task = asyncio.create_task(self._sweeper())

    async def _sweeper(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            for job in self._queues.expire_waiting():
                await self._notify(job, f"任务 #{job.public_id} 已过期丢弃")

    async def terminate(self) -> None:
        self._terminated = True
        tasks = [
            task
            for task in [self._sweeper_task, *self._workers.values()]
            if task is not None
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*tasks, return_exceptions=True)
        self._queues.clear()
