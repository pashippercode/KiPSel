from __future__ import annotations

import re
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Iterable


_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
_NAME_RE = _ALIAS_RE
_COMMAND_RE_TEMPLATE = r"^/?pi\s+{command}(?:\s+(.*))?$"


class QueueError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(slots=True)
class QueuedJob:
    public_id: str
    request_id: str
    alias: str
    unified_msg_origin: str
    text: str
    images: list[dict[str, str]]
    created_at: float
    input_released: bool = False
    cancel_requested: bool = False
    controller_submitted: bool = False

    def release_input(self) -> None:
        self.text = ""
        self.images.clear()
        self.input_released = True

    def release_all(self) -> None:
        self.release_input()
        self.unified_msg_origin = ""


@dataclass(frozen=True, slots=True)
class QueueEntry:
    public_id: str
    alias: str
    state: str
    age_seconds: int


@dataclass(slots=True)
class TakeResult:
    job: QueuedJob | None
    expired: list[QueuedJob] = field(default_factory=list)


class MemoryJobQueues:
    """Independent per-alias FIFO queues with no persistence."""

    def __init__(
        self,
        *,
        max_per_alias: int = 20,
        ttl_seconds: int = 30 * 60,
        now: Callable[[], float] = time.monotonic,
        request_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if not 1 <= max_per_alias <= 100:
            raise ValueError("max_per_alias must be between 1 and 100")
        if not 60 <= ttl_seconds <= 24 * 60 * 60:
            raise ValueError("ttl_seconds must be between 60 and 86400")
        self.max_per_alias = max_per_alias
        self.ttl_seconds = ttl_seconds
        self._now = now
        self._request_id_factory = request_id_factory or (lambda: f"kipsel-{uuid.uuid4().hex}")
        self._queues: dict[str, deque[QueuedJob]] = {}
        self._active: dict[str, QueuedJob] = {}
        self._known_ids: set[str] = set()

    def enqueue(
        self,
        *,
        alias: str,
        unified_msg_origin: str,
        text: str,
        images: list[dict[str, str]],
    ) -> QueuedJob:
        require_name(alias, "alias")
        if not isinstance(unified_msg_origin, str) or not unified_msg_origin:
            raise QueueError("invalid-origin")
        if not isinstance(text, str):
            raise QueueError("invalid-text")
        if not isinstance(images, list):
            raise QueueError("invalid-images")
        queue = self._queues.setdefault(alias, deque())
        if len(queue) >= self.max_per_alias:
            raise QueueError("queue-full")

        request_id = self._new_request_id()
        public_id = request_id.removeprefix("kipsel-")[:12]
        job = QueuedJob(
            public_id=public_id,
            request_id=request_id,
            alias=alias,
            unified_msg_origin=unified_msg_origin,
            text=text,
            images=images,
            created_at=self._now(),
        )
        queue.append(job)
        self._known_ids.add(public_id)
        return job

    def take_next(self, alias: str) -> TakeResult:
        if alias in self._active:
            raise RuntimeError("alias already has active work")
        queue = self._queues.get(alias)
        expired: list[QueuedJob] = []
        now = self._now()
        while queue:
            candidate = queue.popleft()
            if now - candidate.created_at > self.ttl_seconds:
                candidate.release_input()
                self._known_ids.discard(candidate.public_id)
                expired.append(candidate)
                continue
            self._active[alias] = candidate
            if not queue:
                self._queues.pop(alias, None)
            return TakeResult(candidate, expired)
        self._queues.pop(alias, None)
        return TakeResult(None, expired)

    def finish(self, job: QueuedJob) -> None:
        if self._active.get(job.alias) is job:
            self._active.pop(job.alias, None)
        self._known_ids.discard(job.public_id)
        job.release_all()

    def expire_waiting(self) -> list[QueuedJob]:
        expired: list[QueuedJob] = []
        now = self._now()
        for alias in tuple(self._queues):
            kept: deque[QueuedJob] = deque()
            for job in self._queues[alias]:
                if now - job.created_at > self.ttl_seconds:
                    job.release_input()
                    self._known_ids.discard(job.public_id)
                    expired.append(job)
                else:
                    kept.append(job)
            if kept:
                self._queues[alias] = kept
            else:
                self._queues.pop(alias, None)
        return expired

    def active(self, alias: str) -> QueuedJob | None:
        return self._active.get(alias)

    def active_jobs(self) -> list[QueuedJob]:
        return list(self._active.values())

    def is_expired(self, job: QueuedJob) -> bool:
        return self._now() - job.created_at > self.ttl_seconds

    def cancel_queued(self, alias: str, selector: str) -> list[QueuedJob]:
        queue = self._queues.get(alias)
        if not queue:
            return []
        selector = selector.strip().lower()
        if selector != "all" and not re.fullmatch(r"[0-9a-f]{6,32}", selector):
            raise QueueError("invalid-job-id")
        cancelled: list[QueuedJob] = []
        kept: deque[QueuedJob] = deque()
        for job in queue:
            if selector == "all" or job.public_id.lower() == selector:
                job.cancel_requested = True
                job.release_input()
                self._known_ids.discard(job.public_id)
                cancelled.append(job)
            else:
                kept.append(job)
        if kept:
            self._queues[alias] = kept
        else:
            self._queues.pop(alias, None)
        return cancelled

    def entries(self, alias: str | None = None) -> list[QueueEntry]:
        now = self._now()
        aliases: Iterable[str]
        if alias is None:
            aliases = sorted(set(self._queues) | set(self._active))
        else:
            aliases = (alias,)
        result: list[QueueEntry] = []
        for current_alias in aliases:
            active = self._active.get(current_alias)
            if active:
                result.append(
                    QueueEntry(
                        active.public_id,
                        current_alias,
                        "active",
                        max(0, int(now - active.created_at)),
                    )
                )
            for job in self._queues.get(current_alias, ()):
                result.append(
                    QueueEntry(
                        job.public_id,
                        current_alias,
                        "queued",
                        max(0, int(now - job.created_at)),
                    )
                )
        return result

    def waiting_count(self, alias: str) -> int:
        return len(self._queues.get(alias, ()))

    def aliases_with_waiting(self) -> list[str]:
        return sorted(alias for alias, queue in self._queues.items() if queue)

    def clear(self) -> None:
        for job in self._active.values():
            job.cancel_requested = True
            job.release_all()
        for queue in self._queues.values():
            for job in queue:
                job.cancel_requested = True
                job.release_all()
        self._active.clear()
        self._queues.clear()
        self._known_ids.clear()

    def _new_request_id(self) -> str:
        for _ in range(10):
            request_id = self._request_id_factory()
            if not isinstance(request_id, str) or not re.fullmatch(r"kipsel-[0-9a-f]{16,64}", request_id):
                raise ValueError("request_id_factory returned an invalid identifier")
            public_id = request_id.removeprefix("kipsel-")[:12]
            if public_id not in self._known_ids:
                return request_id
        raise RuntimeError("unable to allocate a unique public job identifier")


def require_name(value: str, label: str) -> str:
    if not isinstance(value, str) or not _NAME_RE.fullmatch(value):
        raise QueueError(f"invalid-{label}")
    return value


def command_tail(message: str, command: str) -> str:
    """Return the untouched text following `/pi <command>`.

    AstrBot may expose a command string with or without the configured leading
    slash, so both forms are accepted. Other prefixes and subcommands are not.
    """

    if not isinstance(message, str) or not re.fullmatch(r"[a-z]+", command):
        raise QueueError("invalid-command")
    match = re.fullmatch(
        _COMMAND_RE_TEMPLATE.format(command=re.escape(command)),
        message.strip(),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise QueueError("invalid-command")
    return (match.group(1) or "").strip()


def command_words(message: str, command: str) -> list[str]:
    tail = command_tail(message, command)
    return re.findall(r"\S+", tail)


def parse_start_args(message: str) -> tuple[str, str | None, str | None]:
    words = command_words(message, "start")
    if not 1 <= len(words) <= 3:
        raise QueueError("usage-start")
    alias = require_name(words[0], "alias")
    project = require_name(words[1], "project") if len(words) >= 2 else None
    profile = require_name(words[2], "profile") if len(words) >= 3 else None
    return alias, project, profile


def parse_stop_args(message: str, selected_alias: str | None) -> tuple[str, bool]:
    words = command_words(message, "stop")
    force = False
    if words and words[-1].lower() == "force":
        force = True
        words.pop()
    if len(words) > 1:
        raise QueueError("usage-stop")
    alias = words[0] if words else selected_alias
    if alias is None:
        raise QueueError("no-alias-selected")
    return require_name(alias, "alias"), force


def parse_optional_alias(message: str, command: str, selected_alias: str | None) -> str:
    words = command_words(message, command)
    if len(words) > 1:
        raise QueueError(f"usage-{command}")
    alias = words[0] if words else selected_alias
    if alias is None:
        raise QueueError("no-alias-selected")
    return require_name(alias, "alias")
