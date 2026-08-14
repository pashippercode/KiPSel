import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from client import ControllerClient, validate_controller_url  # noqa: E402


class ValidateControllerUrlTest(unittest.TestCase):
    def test_accepts_loopback_private_and_cgnat(self) -> None:
        accepted = {
            "http://127.0.0.1:8787": "http://127.0.0.1:8787",
            "http://10.0.0.1:8787/": "http://10.0.0.1:8787",
            "http://172.16.0.1:8787": "http://172.16.0.1:8787",
            "http://172.31.255.254:8787": "http://172.31.255.254:8787",
            "http://192.168.1.1:8787": "http://192.168.1.1:8787",
            "http://100.64.0.1:8787": "http://100.64.0.1:8787",
            "http://100.127.255.254:8787": "http://100.127.255.254:8787",
        }
        for raw, expected in accepted.items():
            with self.subTest(raw=raw):
                self.assertEqual(validate_controller_url(raw), expected)

    def test_rejects_public_and_link_local(self) -> None:
        for raw in (
            "http://8.8.8.8:8787",
            "http://1.1.1.1:8787",
            "http://169.254.169.254:8787",
            "http://169.254.0.1:8787",
            "http://100.128.0.1:8787",  # just outside CGNAT 100.64.0.0/10
            "http://172.32.0.1:8787",  # just outside 172.16.0.0/12
            "http://11.0.0.1:8787",  # just outside 10.0.0.0/8
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    validate_controller_url(raw)

    def test_rejects_non_literal_or_wrong_shape(self) -> None:
        for raw in (
            "http://example.com:8787",  # hostname
            "http://[::1]:8787",  # IPv6
            "https://127.0.0.1:8787",  # https not allowed
            "http://127.0.0.1",  # missing port
            "http://127.0.0.1:8787/api",  # path not allowed
            "http://user@127.0.0.1:8787",  # userinfo not allowed
            "http://127.0.0.1:0",  # port out of range
            "http://127.0.0.1:70000",  # port out of range
            "",  # empty
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    validate_controller_url(raw)
    def test_rejects_parser_bypass_forms(self) -> None:
        for raw in (
            "http://127.0.0.1@8.8.8.8:8787",  # userinfo masks public host
            "http://8.8.8.8@127.0.0.1:8787",  # userinfo masks allowed host
            "http://010.0.0.1:8787",  # leading-zero octet
            "http://2130706433:8787",  # decimal integer form of 127.0.0.1
            "http://[::ffff:127.0.0.1]:8787",  # IPv4-mapped IPv6
            "http://[::ffff:808:808]:8787",  # IPv4-mapped IPv6, public
            "http:\\127.0.0.1:8787",  # backslash separator
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    validate_controller_url(raw)


class ControllerClientValidationTest(unittest.TestCase):
    def test_rejects_missing_or_whitespace_bearer(self) -> None:
        for bearer in ("", "has space", " has-space-around "):
            with self.subTest(bearer=bearer):
                with self.assertRaises(ValueError):
                    ControllerClient("http://127.0.0.1:8787", bearer)

    def test_accepts_valid_arguments(self) -> None:
        client = ControllerClient("http://127.0.0.1:8787", "x" * 48)
        self.assertEqual(client.base_url, "http://127.0.0.1:8787")


if __name__ == "__main__":
    unittest.main()
