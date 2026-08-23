import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobRegistry } from "./jobs.ts";

test("tracks completion and keeps a bounded summary", () => {
  const registry = new BackgroundJobRegistry(2);
  const first = registry.start("single");
  assert.match(first.id, /^subagent-/);
  assert.equal(registry.get(first.id)?.status, "running");

  assert.equal(registry.complete(first.id, "done"), true);
  assert.equal(registry.get(first.id)?.status, "completed");
  assert.equal(registry.get(first.id)?.output, "done");

  const second = registry.start("parallel");
  registry.fail(second.id, "failed");
  const third = registry.start("chain");
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get(first.id), undefined);
  assert.equal(registry.get(third.id)?.status, "running");
});

test("cancels jobs through AbortController and does not overwrite cancellation", () => {
  const registry = new BackgroundJobRegistry();
  const job = registry.start("single");

  assert.equal(registry.cancel(job.id), true);
  assert.equal(job.controller.signal.aborted, true);
  assert.equal(registry.get(job.id)?.status, "cancelled");
  assert.equal(registry.complete(job.id, "late output"), false);
  assert.equal(registry.fail(job.id, "late failure", true), false);
});

test("cancelAll only affects running jobs", () => {
  const registry = new BackgroundJobRegistry();
  const running = registry.start("single");
  const done = registry.start("single");
  registry.complete(done.id, "done");

  assert.deepEqual(registry.cancelAll(), [running.id]);
  assert.equal(registry.get(running.id)?.status, "cancelled");
  assert.equal(registry.get(done.id)?.status, "completed");
});
