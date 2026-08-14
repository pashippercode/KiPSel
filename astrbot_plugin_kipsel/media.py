from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import re
import socket
import urllib.parse
from pathlib import Path


ALLOWED_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})


class MediaInputError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def image_payload(
    source: str,
    *,
    max_bytes: int,
    allowed_file_root: str | None = None,
) -> dict[str, str]:
    """Read an image fully into memory and return a controller payload.

    ``allowed_file_root`` gates local file reads (file:// and bare paths);
    when None, local file sources are rejected entirely.
    """
    if not isinstance(source, str) or not source or not 1 <= max_bytes <= 20 * 1024 * 1024:
        raise MediaInputError("invalid-image")
    raw = await _read_source(source, max_bytes=max_bytes, allowed_file_root=allowed_file_root)
    media_type = detect_image_type(raw)
    if media_type is None:
        raise MediaInputError("unsupported-image")
    return {
        "mediaType": media_type,
        "data": base64.b64encode(raw).decode("ascii"),
    }


def detect_image_type(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(raw) >= 12 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


async def _read_source(
    source: str, *, max_bytes: int, allowed_file_root: str | None
) -> bytes:
    if source.startswith("base64://"):
        return _decode_base64(source[9:], max_bytes)
    if source.startswith("data:"):
        header, separator, payload = source.partition(",")
        match = re.fullmatch(r"data:(image/(?:jpeg|png|webp|gif));base64", header, re.IGNORECASE)
        if not separator or not match:
            raise MediaInputError("invalid-image")
        return _decode_base64(payload, max_bytes)

    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme in {"http", "https"}:
        return await _download(source, max_bytes=max_bytes)
    if parsed.scheme == "file":
        if parsed.netloc not in ("", "localhost"):
            raise MediaInputError("invalid-image")
        path = urllib.parse.unquote(parsed.path)
        return await asyncio.to_thread(_read_file, path, max_bytes, allowed_file_root)
    if parsed.scheme:
        raise MediaInputError("invalid-image")

    if _looks_like_base64(source):
        return _decode_base64(source, max_bytes)
    return await asyncio.to_thread(_read_file, source, max_bytes, allowed_file_root)


def _decode_base64(value: str, max_bytes: int) -> bytes:
    if not value or any(char.isspace() for char in value):
        raise MediaInputError("invalid-image")
    if len(value) > ((max_bytes + 2) // 3) * 4:
        raise MediaInputError("image-too-large")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise MediaInputError("invalid-image") from None
    if len(decoded) > max_bytes:
        raise MediaInputError("image-too-large")
    if base64.b64encode(decoded).decode("ascii") != value:
        raise MediaInputError("invalid-image")
    return decoded


def _looks_like_base64(value: str) -> bool:
    return (
        len(value) >= 12
        and len(value) % 4 == 0
        and re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value)
        is not None
    )


def _read_file(path: str, max_bytes: int, allowed_file_root: str | None) -> bytes:
    if not allowed_file_root:
        raise MediaInputError("invalid-image")
    try:
        root = Path(allowed_file_root).resolve(strict=True)
        target = Path(path).resolve(strict=True)
        if not target.is_relative_to(root):
            raise MediaInputError("invalid-image")
        if not target.is_file() or target.stat().st_size > max_bytes:
            raise MediaInputError("image-too-large" if target.is_file() else "invalid-image")
        with target.open("rb") as handle:
            raw = handle.read(max_bytes + 1)
    except MediaInputError:
        raise
    except (OSError, ValueError):
        raise MediaInputError("invalid-image") from None
    if len(raw) > max_bytes:
        raise MediaInputError("image-too-large")
    return raw


async def _download(url: str, *, max_bytes: int) -> bytes:
    try:
        import aiohttp
    except ImportError:
        raise MediaInputError("image-download-unavailable") from None

    timeout = aiohttp.ClientTimeout(total=30, connect=10, sock_read=20)
    headers = {"Accept": "image/jpeg,image/png,image/webp,image/gif"}
    current = url
    try:
        async with aiohttp.ClientSession(
            timeout=timeout,
            trust_env=False,
            auto_decompress=True,
            headers=headers,
        ) as session:
            for redirect_count in range(4):
                await _validate_http_url(current)
                async with session.get(current, allow_redirects=False) as response:
                    if response.status in {301, 302, 303, 307, 308}:
                        if redirect_count >= 3:
                            raise MediaInputError("image-download-failed")
                        location = response.headers.get("Location")
                        if not location:
                            raise MediaInputError("image-download-failed")
                        current = urllib.parse.urljoin(current, location)
                        continue
                    if response.status != 200:
                        raise MediaInputError("image-download-failed")
                    declared = response.headers.get("Content-Length")
                    if declared:
                        try:
                            if int(declared) > max_bytes:
                                raise MediaInputError("image-too-large")
                        except ValueError:
                            raise MediaInputError("image-download-failed") from None
                    output = bytearray()
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        output.extend(chunk)
                        if len(output) > max_bytes:
                            raise MediaInputError("image-too-large")
                    return bytes(output)
    except MediaInputError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        raise MediaInputError("image-download-failed") from None
    raise MediaInputError("image-download-failed")


async def _validate_http_url(value: str) -> None:
    """Reject non-HTTP URLs and any host that does not resolve to global IPs.

    This blocks loopback, link-local, private, CGNAT/Tailscale and metadata
    addresses. DNS is checked at validation time; aiohttp re-resolves when
    connecting, so this is a mitigation rather than a complete anti-rebinding
    guarantee.
    """
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        raise MediaInputError("invalid-image") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port is not None and not 1 <= port <= 65535
    ):
        raise MediaInputError("invalid-image")
    try:
        infos = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(
                parsed.hostname,
                port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            ),
            timeout=10,
        )
    except (OSError, asyncio.TimeoutError):
        raise MediaInputError("image-download-failed") from None
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise MediaInputError("image-download-failed")
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            raise MediaInputError("invalid-image") from None
        if not ip.is_global:
            raise MediaInputError("invalid-image")
