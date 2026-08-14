from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping


_MAX_RESPONSE_BYTES = 1024 * 1024
_TERMINAL_JOB_STATUSES = frozenset({"completed", "failed", "cancelled"})


@dataclass(slots=True)
class ControllerClientError(Exception):
    status: int
    code: str
    retryable: bool = False

    def __str__(self) -> str:
        return f"KiPSel controller request failed ({self.status}/{self.code})"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class ControllerClient:
    """Small async wrapper around KiPSel's external controller API.

    Requests run in worker threads so AstrBot's event loop is never blocked by
    the controller's long-poll endpoint. The configured endpoint must be a
    literal Tailscale IPv4 address; redirects and environment proxies are
    disabled so the bearer cannot be forwarded elsewhere.
    """

    def __init__(self, base_url: str, bearer: str, *, timeout_seconds: float = 35.0) -> None:
        self.base_url = validate_controller_url(base_url)
        if not isinstance(bearer, str) or not bearer or any(char.isspace() for char in bearer):
            raise ValueError("controller_bearer is required and cannot contain whitespace")
        if not isinstance(timeout_seconds, (int, float)) or not 1 <= timeout_seconds <= 120:
            raise ValueError("controller timeout must be between 1 and 120 seconds")
        self._bearer = bearer
        self._timeout = float(timeout_seconds)
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirect(),
        )

    async def health(self) -> Mapping[str, Any]:
        return await self._request("GET", "/v1/health")

    async def projects(self) -> Mapping[str, Any]:
        return await self._request("GET", "/v1/projects")

    async def sessions(self) -> list[Mapping[str, Any]]:
        payload = await self._request("GET", "/v1/sessions")
        sessions = payload.get("sessions")
        if not isinstance(sessions, list) or any(not isinstance(item, Mapping) for item in sessions):
            raise ControllerClientError(502, "invalid-controller-response")
        return sessions

    async def start_session(
        self,
        alias: str,
        *,
        project: str | None = None,
        profile: str | None = None,
    ) -> Mapping[str, Any]:
        body: dict[str, Any] = {"alias": alias}
        if project is not None:
            body["project"] = project
        if profile is not None:
            body["profile"] = profile
        payload = await self._request("POST", "/v1/sessions/start", body)
        return _mapping_field(payload, "session")

    async def stop_session(self, alias: str, *, force: bool = False) -> Mapping[str, Any]:
        payload = await self._request(
            "POST",
            "/v1/sessions/stop",
            {"alias": alias, "force": bool(force)},
        )
        return _mapping_field(payload, "session")

    async def abort_session(self, alias: str) -> Mapping[str, Any]:
        return await self._request("POST", "/v1/sessions/abort", {"alias": alias})

    async def submit_job(
        self,
        *,
        request_id: str,
        alias: str,
        text: str,
        images: list[dict[str, str]],
    ) -> Mapping[str, Any]:
        payload = await self._request(
            "POST",
            "/v1/jobs",
            {
                "requestId": request_id,
                "alias": alias,
                "text": text,
                "images": images,
            },
        )
        return _mapping_field(payload, "job")

    async def job_result(self, request_id: str) -> Mapping[str, Any]:
        query = urllib.parse.urlencode({"requestId": request_id})
        payload = await self._request("GET", f"/v1/jobs/result?{query}")
        return _mapping_field(payload, "job")

    async def wait_for_job(
        self, request_id: str, *, max_seconds: float | None = None
    ) -> Mapping[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = None if max_seconds is None else loop.time() + max_seconds
        while True:
            if deadline is not None and loop.time() >= deadline:
                raise ControllerClientError(0, "job-wait-timeout")
            job = await self.job_result(request_id)
            status = job.get("status")
            if status in _TERMINAL_JOB_STATUSES:
                return job
            if not isinstance(status, str):
                raise ControllerClientError(502, "invalid-controller-response")

    async def cancel_job(self, request_id: str) -> Mapping[str, Any]:
        payload = await self._request(
            "POST",
            "/v1/jobs/cancel",
            {"requestId": request_id},
        )
        return _mapping_field(payload, "job")

    async def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        return await asyncio.to_thread(self._request_sync, method, path, body)

    def _request_sync(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None,
    ) -> Mapping[str, Any]:
        if not path.startswith("/"):
            raise ControllerClientError(500, "invalid-client-request")
        encoded = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._bearer}",
            "User-Agent": "KiPSel-AstrBot/0.1",
        }
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=encoded,
            headers=headers,
            method=method,
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                payload = _read_json_response(response, int(response.status))
        except urllib.error.HTTPError as error:
            payload = _read_json_response(error, int(error.code), allow_invalid=True)
            code = payload.get("error") if isinstance(payload.get("error"), str) else "controller-error"
            retryable = error.code == 429 or error.code >= 500
            raise ControllerClientError(int(error.code), code, retryable) from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
            raise ControllerClientError(0, "controller-unavailable", True) from None
        return payload


# Ranges the controller may legitimately live on. The bearer is sent over plain
# HTTP, so the destination must be a local, private, or Tailscale address.
# Link-local (169.254.0.0/16) is deliberately excluded: it contains cloud
# metadata endpoints (169.254.169.254) and no realistic controller placement.
_ALLOWED_CONTROLLER_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "127.0.0.0/8",  # loopback
        "10.0.0.0/8",  # RFC1918 private
        "172.16.0.0/12",  # RFC1918 private
        "192.168.0.0/16",  # RFC1918 private
        "100.64.0.0/10",  # CGNAT (Tailscale)
    )
)


def validate_controller_url(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("controller_url must be a string")
    parsed = urllib.parse.urlsplit(value.strip())
    if (
        parsed.scheme != "http"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.port is None
    ):
        raise ValueError("controller_url must be an HTTP origin with an explicit port")
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as error:
        raise ValueError("controller_url host must be a literal IPv4 address") from error
    if address.version != 4 or not any(
        address in network for network in _ALLOWED_CONTROLLER_NETWORKS
    ):
        raise ValueError(
            "controller_url host must be a non-public literal IPv4"
            " (loopback, RFC1918 private, or Tailscale CGNAT 100.64.0.0/10)"
        )
    if not 1 <= parsed.port <= 65535:
        raise ValueError("controller_url port is invalid")
    return f"http://{address}:{parsed.port}"


def _mapping_field(payload: Mapping[str, Any], field: str) -> Mapping[str, Any]:
    value = payload.get(field)
    if not isinstance(value, Mapping):
        raise ControllerClientError(502, "invalid-controller-response")
    return value


def _read_json_response(response, status: int, *, allow_invalid: bool = False) -> Mapping[str, Any]:  # noqa: ANN001
    declared = response.headers.get("Content-Length")
    if declared:
        try:
            if int(declared) > _MAX_RESPONSE_BYTES:
                raise ControllerClientError(status, "controller-response-too-large")
        except ValueError:
            if not allow_invalid:
                raise ControllerClientError(status, "invalid-controller-response") from None
    raw = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise ControllerClientError(status, "controller-response-too-large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        if allow_invalid:
            return {}
        raise ControllerClientError(status, "invalid-controller-response") from None
    if not isinstance(payload, Mapping):
        if allow_invalid:
            return {}
        raise ControllerClientError(status, "invalid-controller-response")
    return payload
