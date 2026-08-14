import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKER_TYPE,
  backoffDelay,
  harvestResult,
  hasUserAfterMarker,
  parseRuntimeConfig,
  sleepAbortable,
  toUserContent,
  validateJobPayload,
} from "./core.ts";

const UUID = "00000000-0000-4000-8000-000000000001";

function marker(jobId: string) {
  return { type: "custom", id: `marker-${jobId}`, customType: MARKER_TYPE, data: { jobId } };
}

function user(text: string) {
  return { type: "message", id: `user-${text}`, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(text: string, stopReason = "stop") {
  return {
    type: "message",
    id: `assistant-${text}`,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text }],
      stopReason,
    },
  };
}

function toolResult() {
  return {
    type: "message",
    id: "tool-result",
    message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
  };
}

test("runtime config accepts only a loopback controller URL", () => {
  const valid = parseRuntimeConfig({
    KIPSEL_INTERNAL_URL: "http://127.0.0.1:8788",
    KIPSEL_ALIAS: "qq_one",
    KIPSEL_SESSION_ID: UUID,
    KIPSEL_INTERNAL_TOKEN: "runtime-only-token",
  });
  assert.equal(valid.ok, true);
  for (const url of [
    "http://0.0.0.0:8788",
    "http://100.64.0.1:8788",
    "https://127.0.0.1:8788",
    "http://127.0.0.1:8788/path",
  ]) {
    assert.equal(
      parseRuntimeConfig({
        KIPSEL_INTERNAL_URL: url,
        KIPSEL_ALIAS: "qq_one",
        KIPSEL_SESSION_ID: UUID,
        KIPSEL_INTERNAL_TOKEN: "runtime-only-token",
      }).ok,
      false,
    );
  }
});

test("job validation preserves canonical images in the pi 0.84 ImageContent shape", () => {
  const data = Buffer.from("image bytes").toString("base64");
  const result = validateJobPayload({
    id: "job-12345678",
    leaseId: "lease-12345678",
    text: "inspect",
    images: [{ mediaType: "image/png", data }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(toUserContent(result.value), [
    { type: "text", text: "inspect" },
    { type: "image", data, mimeType: "image/png" },
  ]);
});

test("job validation rejects malformed base64, media types, limits, and empty work", () => {
  const base = { id: "job-12345678", leaseId: "lease-12345678", text: "", images: [] };
  assert.equal(validateJobPayload(base).ok, false);
  assert.equal(
    validateJobPayload({ ...base, images: [{ mediaType: "image/svg+xml", data: "YQ==" }] }).ok,
    false,
  );
  assert.equal(
    validateJobPayload({ ...base, images: [{ mediaType: "image/png", data: "not-base64" }] }).ok,
    false,
  );
  assert.equal(
    validateJobPayload({
      ...base,
      images: Array.from({ length: 4 }, () => ({ mediaType: "image/png", data: "YQ==" })),
    }).ok,
    false,
  );
});

test("harvest returns the last assistant text in the marked user segment", () => {
  const jobId = "job-one";
  const entries = [
    user("older"),
    assistant("older answer"),
    marker(jobId),
    user("target"),
    assistant("tool preface", "toolUse"),
    toolResult(),
    assistant("final answer", "stop"),
  ];
  assert.equal(hasUserAfterMarker(entries, jobId), true);
  assert.deepEqual(harvestResult(entries, jobId), {
    status: "done",
    jobId,
    text: "final answer",
    stopReason: "stop",
    errorCode: null,
    interrupted: false,
  });
});

test("a later local user message truncates the target segment and marks interruption", () => {
  const jobId = "job-interrupted";
  const entries = [
    marker(jobId),
    user("remote target"),
    assistant("partial answer", "stop"),
    user("local user input"),
    assistant("must not be returned", "stop"),
  ];
  const result = harvestResult(entries, jobId);
  assert.equal(result.status, "interrupted");
  assert.equal(result.text, "partial answer");
  assert.equal(result.interrupted, true);
});

test("missing marker, missing user, and unfinished assistant remain pending", () => {
  assert.equal(harvestResult([user("x"), assistant("x")], "missing").status, "pending");
  assert.equal(harvestResult([marker("job")], "job").status, "pending");
  assert.equal(
    harvestResult([marker("job"), user("target"), assistant("partial", "toolUse")], "job").status,
    "pending",
  );
});

test("assistant error and abort produce stable terminal states", () => {
  const errored = harvestResult([marker("error"), user("target"), assistant("failure", "error")], "error");
  assert.equal(errored.status, "error");
  assert.equal(errored.errorCode, "assistant-error");
  const aborted = harvestResult([marker("abort"), user("target"), assistant("partial", "aborted")], "abort");
  assert.equal(aborted.status, "interrupted");
  assert.equal(aborted.interrupted, true);
});

test("last matching marker wins and prevents an old answer from being reused", () => {
  const entries = [
    marker("same"),
    user("first"),
    assistant("old answer"),
    marker("same"),
  ];
  assert.equal(harvestResult(entries, "same").status, "pending");
  assert.equal(hasUserAfterMarker(entries, "same"), false);
});

test("backoff and abortable sleep are bounded and cancellable", async () => {
  assert.deepEqual([0, 1, 2, 10].map((attempt) => backoffDelay(attempt, 100, 500)), [100, 200, 400, 500]);
  const controller = new AbortController();
  const sleeping = sleepAbortable(10_000, controller.signal);
  controller.abort();
  assert.equal(await sleeping, false);
  assert.equal(await sleepAbortable(1), true);
});
