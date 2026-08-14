import asyncio
import base64
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from media import (  # noqa: E402
    MediaInputError,
    _validate_http_url,
    detect_image_type,
    image_payload,
)
from queueing import (  # noqa: E402
    QueueError,
    command_tail,
    parse_optional_alias,
    parse_start_args,
    parse_stop_args,
    require_name,
)

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


class CommandTailTest(unittest.TestCase):
    def test_with_and_without_slash(self):
        self.assertEqual(command_tail("/pi ask 你好", "ask"), "你好")
        self.assertEqual(command_tail("pi ask 你好", "ask"), "你好")

    def test_inner_whitespace_preserved(self):
        self.assertEqual(command_tail("pi ask  多词  保留", "ask"), "多词  保留")

    def test_multiline_preserved(self):
        self.assertEqual(command_tail("pi ask 第一行\n第二行", "ask"), "第一行\n第二行")

    def test_no_argument(self):
        self.assertEqual(command_tail("pi ask", "ask"), "")

    def test_wrong_command_rejected(self):
        with self.assertRaises(QueueError) as ctx:
            command_tail("pi stop x", "ask")
        self.assertEqual(ctx.exception.code, "invalid-command")


class StartArgsTest(unittest.TestCase):
    def test_alias_only(self):
        self.assertEqual(parse_start_args("pi start demo"), ("demo", None, None))

    def test_full(self):
        self.assertEqual(
            parse_start_args("pi start demo proj prof"), ("demo", "proj", "prof")
        )

    def test_invalid_alias(self):
        with self.assertRaises(QueueError) as ctx:
            parse_start_args("pi start ../bad")
        self.assertEqual(ctx.exception.code, "invalid-alias")

    def test_missing_alias(self):
        with self.assertRaises(QueueError) as ctx:
            parse_start_args("pi start")
        self.assertEqual(ctx.exception.code, "usage-start")


class StopArgsTest(unittest.TestCase):
    def test_requires_selection(self):
        with self.assertRaises(QueueError) as ctx:
            parse_stop_args("pi stop", None)
        self.assertEqual(ctx.exception.code, "no-alias-selected")

    def test_uses_selected(self):
        self.assertEqual(parse_stop_args("pi stop", "sel"), ("sel", False))

    def test_force_with_selected(self):
        self.assertEqual(parse_stop_args("pi stop force", "sel"), ("sel", True))

    def test_explicit_alias_and_force(self):
        self.assertEqual(parse_stop_args("pi stop alpha force", None), ("alpha", True))


class OptionalAliasTest(unittest.TestCase):
    def test_explicit_wins(self):
        self.assertEqual(parse_optional_alias("pi queue beta", "queue", "sel"), "beta")

    def test_falls_back_to_selected(self):
        self.assertEqual(parse_optional_alias("pi queue", "queue", "sel"), "sel")

    def test_none_available(self):
        with self.assertRaises(QueueError) as ctx:
            parse_optional_alias("pi queue", "queue", None)
        self.assertEqual(ctx.exception.code, "no-alias-selected")


class RequireNameTest(unittest.TestCase):
    def test_boundaries(self):
        self.assertEqual(require_name("a" * 32, "alias"), "a" * 32)
        self.assertEqual(require_name("1abc", "alias"), "1abc")
        for bad in ("a" * 33, "_abc", "-abc", ""):
            with self.assertRaises(QueueError):
                require_name(bad, "alias")


class DetectImageTypeTest(unittest.TestCase):
    def test_magics(self):
        self.assertEqual(detect_image_type(PNG_BYTES), "image/png")
        self.assertEqual(detect_image_type(b"\xff\xd8\xff\xe0" + b"\x00" * 8), "image/jpeg")
        self.assertEqual(detect_image_type(b"GIF87a" + b"\x00" * 8), "image/gif")
        self.assertEqual(detect_image_type(b"GIF89a" + b"\x00" * 8), "image/gif")
        self.assertEqual(
            detect_image_type(b"RIFF" + b"\x00" * 4 + b"WEBP" + b"\x00" * 4), "image/webp"
        )

    def test_unknown(self):
        self.assertIsNone(detect_image_type(b"\x00" * 32))


class ImagePayloadTest(unittest.TestCase):
    def test_base64_prefix(self):
        result = asyncio.run(image_payload("base64://" + PNG_B64, max_bytes=1024))
        self.assertEqual(result, {"mediaType": "image/png", "data": PNG_B64})

    def test_bare_base64(self):
        result = asyncio.run(image_payload(PNG_B64, max_bytes=1024))
        self.assertEqual(result["mediaType"], "image/png")

    def test_data_url(self):
        result = asyncio.run(
            image_payload(f"data:image/png;base64,{PNG_B64}", max_bytes=1024)
        )
        self.assertEqual(result, {"mediaType": "image/png", "data": PNG_B64})

    def test_non_canonical_base64(self):
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("base64://AAAA BBBB", max_bytes=1024))
        self.assertEqual(ctx.exception.code, "invalid-image")
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("base64://AAAA==", max_bytes=1024))
        self.assertEqual(ctx.exception.code, "invalid-image")

    def test_too_large(self):
        big = base64.b64encode(b"\x00" * 2048).decode("ascii")
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("base64://" + big, max_bytes=1024))
        self.assertEqual(ctx.exception.code, "image-too-large")

    def test_unsupported_type(self):
        blob = base64.b64encode(b"\x01" * 32).decode("ascii")
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("base64://" + blob, max_bytes=1024))
        self.assertEqual(ctx.exception.code, "unsupported-image")

    def test_file_requires_allowed_root(self):
        with tempfile.TemporaryDirectory() as root:
            target = pathlib.Path(root) / "pic.png"
            target.write_bytes(PNG_BYTES)
            with self.assertRaises(MediaInputError) as ctx:
                asyncio.run(image_payload(target.as_uri(), max_bytes=1024))
            self.assertEqual(ctx.exception.code, "invalid-image")

    def test_file_inside_allowed_root(self):
        with tempfile.TemporaryDirectory() as root:
            target = pathlib.Path(root) / "pic.png"
            target.write_bytes(PNG_BYTES)
            result = asyncio.run(
                image_payload(target.as_uri(), max_bytes=1024, allowed_file_root=root)
            )
            self.assertEqual(result, {"mediaType": "image/png", "data": PNG_B64})

    def test_file_outside_allowed_root_rejected(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            target = pathlib.Path(other) / "pic.png"
            target.write_bytes(PNG_BYTES)
            with self.assertRaises(MediaInputError) as ctx:
                asyncio.run(
                    image_payload(target.as_uri(), max_bytes=1024, allowed_file_root=root)
                )
            self.assertEqual(ctx.exception.code, "invalid-image")

    def test_http_private_address_rejected(self):
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("http://127.0.0.1/x.png", max_bytes=1024))
        self.assertIn(ctx.exception.code, {"invalid-image", "image-download-unavailable", "image-download-failed"})
        with self.assertRaises(MediaInputError) as ctx:
            asyncio.run(image_payload("http://169.254.169.254/latest.png", max_bytes=1024))
        self.assertIn(ctx.exception.code, {"invalid-image", "image-download-unavailable", "image-download-failed"})

    def test_validate_http_url_rejects_non_global_literals(self):
        # 字面 IP 不依赖 DNS / aiohttp，可区分 is_global 校验是否生效
        for url in (
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",
            "http://100.100.100.100/",
            "http://[::1]/",
        ):
            with self.assertRaises(MediaInputError) as ctx:
                asyncio.run(_validate_http_url(url))
            self.assertEqual(ctx.exception.code, "invalid-image", url)

    def test_validate_http_url_accepts_global_literal(self):
        asyncio.run(_validate_http_url("http://8.8.8.8/"))


if __name__ == "__main__":
    unittest.main()
