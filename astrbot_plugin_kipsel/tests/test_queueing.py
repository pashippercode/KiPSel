import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from queueing import MemoryJobQueues, QueueError  # noqa: E402


def make_queues(**kwargs):
    clock = [1000.0]
    queues = MemoryJobQueues(now=lambda: clock[0], **kwargs)
    return queues, clock


def enqueue(queues, alias="alpha", text="hello", umo="platform:FriendMessage:u1"):
    return queues.enqueue(alias=alias, unified_msg_origin=umo, text=text, images=[])


class AliasValidationTest(unittest.TestCase):
    def test_invalid_aliases_rejected(self):
        queues, _ = make_queues()
        for bad in ("", "../x", "a" * 33, "-lead", "_lead", "has space"):
            with self.assertRaises(QueueError) as ctx:
                enqueue(queues, alias=bad)
            self.assertEqual(ctx.exception.code, "invalid-alias")


class FifoTest(unittest.TestCase):
    def test_fifo_order(self):
        queues, _ = make_queues()
        first = enqueue(queues, text="first")
        second = enqueue(queues, text="second")
        take = queues.take_next("alpha")
        self.assertIs(take.job, first)
        queues.finish(take.job)
        take = queues.take_next("alpha")
        self.assertIs(take.job, second)

    def test_public_id_derived_from_request_id(self):
        queues, _ = make_queues()
        job = enqueue(queues)
        self.assertTrue(job.request_id.startswith("kipsel-"))
        self.assertEqual(job.public_id, job.request_id.removeprefix("kipsel-")[:12])


class LimitTest(unittest.TestCase):
    def test_queue_full(self):
        queues, _ = make_queues(max_per_alias=2)
        enqueue(queues, text="a")
        enqueue(queues, text="b")
        with self.assertRaises(QueueError) as ctx:
            enqueue(queues, text="c")
        self.assertEqual(ctx.exception.code, "queue-full")


class TtlTest(unittest.TestCase):
    def test_take_next_skips_expired(self):
        queues, clock = make_queues(ttl_seconds=60)
        old = enqueue(queues, text="old")
        clock[0] += 120
        fresh = enqueue(queues, text="fresh")
        take = queues.take_next("alpha")
        self.assertEqual([job.public_id for job in take.expired], [old.public_id])
        self.assertEqual(old.text, "")
        self.assertTrue(old.input_released)
        self.assertIs(take.job, fresh)

    def test_expire_waiting(self):
        queues, clock = make_queues(ttl_seconds=60)
        job = enqueue(queues)
        clock[0] += 120
        expired = queues.expire_waiting()
        self.assertEqual([item.public_id for item in expired], [job.public_id])
        self.assertEqual(queues.entries("alpha"), [])


class ActiveGuardTest(unittest.TestCase):
    def test_second_take_raises_until_finish(self):
        queues, _ = make_queues()
        enqueue(queues, text="a")
        enqueue(queues, text="b")
        first = queues.take_next("alpha").job
        with self.assertRaises(RuntimeError):
            queues.take_next("alpha")
        queues.finish(first)
        take = queues.take_next("alpha")
        self.assertEqual(take.job.text, "b")


class CancelTest(unittest.TestCase):
    def test_cancel_by_id_and_all(self):
        queues, _ = make_queues()
        job_a = enqueue(queues, text="a")
        job_b = enqueue(queues, text="b")
        cancelled = queues.cancel_queued("alpha", job_a.public_id)
        self.assertEqual([job.public_id for job in cancelled], [job_a.public_id])
        remaining = queues.entries("alpha")
        self.assertEqual([entry.public_id for entry in remaining], [job_b.public_id])
        cancelled = queues.cancel_queued("alpha", "all")
        self.assertEqual([job.public_id for job in cancelled], [job_b.public_id])
        self.assertEqual(queues.entries("alpha"), [])

    def test_invalid_selector(self):
        queues, _ = make_queues()
        enqueue(queues)
        with self.assertRaises(QueueError) as ctx:
            queues.cancel_queued("alpha", "zz!!")
        self.assertEqual(ctx.exception.code, "invalid-job-id")


class RedactionTest(unittest.TestCase):
    def test_entries_have_no_sensitive_fields(self):
        queues, _ = make_queues()
        enqueue(queues)
        entry = queues.entries("alpha")[0]
        self.assertFalse(hasattr(entry, "text"))
        self.assertFalse(hasattr(entry, "images"))
        self.assertFalse(hasattr(entry, "unified_msg_origin"))


class RequestIdTest(unittest.TestCase):
    def test_duplicate_request_id_raises(self):
        queues, _ = make_queues(
            request_id_factory=lambda: "kipsel-" + "a" * 32,
        )
        enqueue(queues, text="a")
        with self.assertRaises(RuntimeError):
            enqueue(queues, text="b")


class ClearTest(unittest.TestCase):
    def test_clear_releases_everything(self):
        queues, _ = make_queues()
        active = enqueue(queues, text="active")
        queues.take_next("alpha")
        waiting = enqueue(queues, text="waiting")
        queues.clear()
        self.assertEqual(queues.entries(), [])
        self.assertEqual(queues.waiting_count("alpha"), 0)
        self.assertIsNone(queues.active("alpha"))
        self.assertEqual(active.text, "")
        self.assertEqual(waiting.text, "")
        self.assertEqual(active.unified_msg_origin, "")


if __name__ == "__main__":
    unittest.main()
