import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JobStore,
  assessProcessOwnership,
  parseProcStat,
  validateAlias,
  verifyBearer,
} from "./registry.mjs";
import { createController } from "./server.mjs";

function procStat(pid, startTime = "9001") {
  const fields = [
    "S",
    "1",
    String(pid),
    String(pid),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    startTime,
  ];
  return `${pid} (xterm (KiPSel test)) ${fields.join(" ")}`;
}

function fakeProcessRead(spawns) {
  return async (path) => {
    const match = /^\/proc\/(\d+)\/(stat|environ|cmdline)$/.exec(path);
    if (!match) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    const pid = Number(match[1]);
    const call = spawns.find((item) => item.child.pid === pid);
    if (!call) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    if (match[2] === "stat") return procStat(pid, call.startTime);
    if (match[2] === "environ") {
      return `KIPSEL_OWNER=${call.options.env.KIPSEL_OWNER}\0KIPSEL_SESSION_ID=${call.options.env.KIPSEL_SESSION_ID}\0`;
    }
    return `${call.file}\0${call.args.join("\0")}\0`;
  };
}

function makeSpawn(spawns) {
  let pid = 31_000;
  return (file, args, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.unref = () => {};
    const call = { file, args, options, child, startTime: String(80_000 + pid) };
    spawns.push(call);
    return child;
  };
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "kipsel-controller-test-"));
  const bearer = randomBytes(24).toString("base64url");
  const spawns = [];
  const config = {
    external: {
      host: "127.0.0.1",
      port: 0,
      allowedSources: ["127.0.0.1"],
      bearerSha256: createHash("sha256").update(bearer).digest("hex"),
    },
    internal: { host: "127.0.0.1", port: 0 },
    statePath: join(root, "state.json"),
    terminal: {
      executable: "/usr/bin/xterm",
      piExecutable: "/test/bin/pi",
      extensionPath: "/test/KiPSel/tui-extension/index.ts",
      display: ":test",
      xauthority: "/test/.Xauthority",
    },
    projects: { demo: root },
    profiles: {
      text: { model: null, vision: false },
      vision: { model: "test/provider-model", vision: true },
    },
    defaults: { project: "demo", profile: "text" },
    limits: {
      maxSessions: 1,
      maxJobsPerAlias: 4,
      jobTtlMs: 5_000,
      maxTextChars: 10_000,
      maxImageCount: 3,
      maxImageBytesPerImage: 1_024,
      maxImageBytesTotal: 2_048,
      maxBodyBytes: 64_000,
      resultPollMs: 40,
      internalPollMs: 40,
      leaseAckMs: 200,
      stopGraceMs: 20,
      signalGraceMs: 20,
    },
    ...overrides,
  };
  const controller = await createController(config, {
    spawn: makeSpawn(spawns),
    readFile: fakeProcessRead(spawns),
    kill: () => {},
  });
  const addresses = await controller.start();
  const external = `http://127.0.0.1:${addresses.external.port}`;
  const internal = `http://127.0.0.1:${addresses.internal.port}`;
  return {
    bearer,
    config,
    controller,
    external,
    internal,
    spawns,
    async close() {
      await controller.stop();
    },
  };
}

async function request(base, path, { bearer, body, method = body === undefined ? "GET" : "POST" } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

async function startSession(context, alias = "alpha", profile = "vision") {
  return request(context.external, "/v1/sessions/start", {
    bearer: context.bearer,
    body: { alias, project: "demo", profile },
  });
}

test("registry helpers enforce alias, bearer, and four ownership properties", () => {
  assert.equal(validateAlias("qq_session-1"), true);
  assert.equal(validateAlias("../other"), false);
  const bearer = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(bearer).digest("hex");
  assert.equal(verifyBearer(bearer, hash), true);
  assert.equal(verifyBearer(`${bearer}x`, hash), false);

  const statText = procStat(42, "123456789");
  assert.equal(parseProcStat(statText)?.startTime, "123456789");
  const expected = { pid: 42, startTime: "123456789", ownerMarker: "owned", sessionId: "session" };
  assert.deepEqual(
    assessProcessOwnership(
      {
        statText,
        environText: "KIPSEL_OWNER=owned\0KIPSEL_SESSION_ID=session\0",
        cmdlineText: "pi\0--session-id\0session\0",
      },
      expected,
    ),
    { owned: true, reason: "ok" },
  );
  assert.equal(
    assessProcessOwnership(
      {
        statText,
        environText: "KIPSEL_OWNER=other\0KIPSEL_SESSION_ID=session\0",
        cmdlineText: "pi\0--session-id\0session\0",
      },
      expected,
    ).owned,
    false,
  );
});

test("external API rejects a request without bearer authentication", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const { response, json } = await request(context.external, "/v1/health");
  assert.equal(response.status, 401);
  assert.equal(json.error, "unauthorized");
});

test("start uses an argv array, keeps internal token out of argv, and enforces session limit", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const started = await startSession(context);
  assert.equal(started.response.status, 200);
  assert.equal(started.json.session.project, "demo");
  assert.equal(context.spawns.length, 1);
  const call = context.spawns[0];
  assert.equal(call.file, "/usr/bin/xterm");
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.cwd.startsWith(tmpdir()), true);
  assert.equal(call.args.includes("--session-id"), true);
  assert.equal(call.args.includes("--no-session"), true);
  assert.equal(call.args.includes("--extension"), true);
  assert.equal(call.args.includes("--model"), true);
  assert.equal(call.args.includes(call.options.env.KIPSEL_INTERNAL_TOKEN), false);

  const second = await startSession(context, "beta");
  assert.equal(second.response.status, 429);
  assert.equal(second.json.error, "session-limit");
});

test("submit, internal poll/ack/result, and external result return the real result", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const started = await startSession(context);
  const listed = await request(context.external, "/v1/sessions", { bearer: context.bearer });
  assert.equal(listed.json.sessions[0].project, "demo");
  const sessionId = started.json.session.sessionId;
  const internalToken = context.spawns[0].options.env.KIPSEL_INTERNAL_TOKEN;
  const requestId = "request-real-result";

  const submitted = await request(context.external, "/v1/jobs", {
    bearer: context.bearer,
    body: { requestId, alias: "alpha", text: "test prompt", images: [] },
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.json.job.status, "queued");
  assert.equal("text" in submitted.json.job, false);

  const held = await request(context.internal, "/internal/poll", {
    bearer: internalToken,
    body: { sessionId, ready: false },
  });
  assert.equal(held.json.kind, "idle");

  const polled = await request(context.internal, "/internal/poll", {
    bearer: internalToken,
    body: { sessionId, ready: true },
  });
  assert.equal(polled.response.status, 200);
  assert.equal(polled.json.kind, "job");
  const { id: jobId, leaseId } = polled.json.job;

  const acknowledged = await request(context.internal, "/internal/job/ack", {
    bearer: internalToken,
    body: { sessionId, jobId, leaseId },
  });
  assert.equal(acknowledged.response.status, 200);

  const resumed = await request(context.internal, "/internal/poll", {
    bearer: internalToken,
    body: { sessionId, ready: false },
  });
  assert.equal(resumed.json.kind, "resume");
  assert.equal(resumed.json.job.id, jobId);
  assert.equal(resumed.json.job.text, "test prompt");
  assert.deepEqual(resumed.json.job.images, []);

  const suppressed = await request(context.internal, "/internal/poll", {
    bearer: internalToken,
    body: { sessionId, ready: false, currentJobId: jobId },
  });
  assert.equal(suppressed.json.kind, "idle");

  const completed = await request(context.internal, "/internal/job/result", {
    bearer: internalToken,
    body: { sessionId, jobId, leaseId, text: "actual assistant answer", interrupted: false },
  });
  assert.equal(completed.response.status, 200);

  const result = await request(
    context.external,
    `/v1/jobs/result?requestId=${encodeURIComponent(requestId)}`,
    { bearer: context.bearer },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.json.job.status, "completed");
  assert.equal(result.json.job.resultText, "actual assistant answer");
  assert.notEqual(result.json.job.resultText, "delivered");
  assert.equal(context.controller.jobs.get(jobId).text, "");
  assert.deepEqual(context.controller.jobs.get(jobId).images, []);
});

test("requestId is idempotent only for the same payload", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await startSession(context);
  const body = { requestId: "request-idempotent", alias: "alpha", text: "one", images: [] };
  const first = await request(context.external, "/v1/jobs", { bearer: context.bearer, body });
  const duplicate = await request(context.external, "/v1/jobs", { bearer: context.bearer, body });
  assert.equal(first.json.job.id, duplicate.json.job.id);

  const conflict = await request(context.external, "/v1/jobs", {
    bearer: context.bearer,
    body: { ...body, text: "two" },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.error, "request-conflict");
});

test("internal API rejects the wrong per-session token", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const started = await startSession(context);
  const response = await request(context.internal, "/internal/heartbeat", {
    bearer: randomBytes(18).toString("base64url"),
    body: { sessionId: started.json.session.sessionId },
  });
  assert.equal(response.response.status, 401);
  assert.equal(response.json.error, "unauthorized");
});

test("images require a vision profile", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await startSession(context, "alpha", "text");
  const image = Buffer.from("test image bytes").toString("base64");
  const submitted = await request(context.external, "/v1/jobs", {
    bearer: context.bearer,
    body: {
      requestId: "request-image-profile",
      alias: "alpha",
      text: "inspect",
      images: [{ mediaType: "image/png", data: image }],
    },
  });
  assert.equal(submitted.response.status, 409);
  assert.equal(submitted.json.error, "vision-required");
});

test("non-force stop refuses an alias with queued work", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await startSession(context);
  await request(context.external, "/v1/jobs", {
    bearer: context.bearer,
    body: { requestId: "request-busy-stop", alias: "alpha", text: "queued", images: [] },
  });
  const stopped = await request(context.external, "/v1/sessions/stop", {
    bearer: context.bearer,
    body: { alias: "alpha", force: false },
  });
  assert.equal(stopped.response.status, 409);
  assert.equal(stopped.json.error, "session-busy");
});

test("unknown GET route returns 404 instead of a body-parse error", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const { response, json } = await request(context.external, "/v1/nope", {
    bearer: context.bearer,
  });
  assert.equal(response.status, 404);
  assert.equal(json.error, "not-found");
});

test("concurrent starts are serialized and the session limit still holds", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const [first, second] = await Promise.all([
    startSession(context, "alpha"),
    startSession(context, "beta"),
  ]);
  const statuses = [first.response.status, second.response.status].sort();
  assert.deepEqual(statuses, [200, 429]);
  assert.equal(context.spawns.length, 1);
});

test("watchdog fails a running job when heartbeats go stale", async (t) => {
  const context = await fixture({
    limits: {
      maxSessions: 1,
      maxJobsPerAlias: 4,
      jobTtlMs: 60_000,
      maxTextChars: 10_000,
      maxImageCount: 3,
      maxImageBytesPerImage: 1_024,
      maxImageBytesTotal: 2_048,
      maxBodyBytes: 64_000,
      resultPollMs: 40,
      internalPollMs: 40,
      leaseAckMs: 200,
      stopGraceMs: 20,
      signalGraceMs: 20,
      heartbeatTimeoutMs: 100,
      watchdogIntervalMs: 50,
    },
  });
  t.after(() => context.close());
  const started = await startSession(context);
  const sessionId = started.json.session.sessionId;
  const internalToken = context.spawns[0].options.env.KIPSEL_INTERNAL_TOKEN;

  await request(context.external, "/v1/jobs", {
    bearer: context.bearer,
    body: { requestId: "request-watchdog", alias: "alpha", text: "work", images: [] },
  });
  const polled = await request(context.internal, "/internal/poll", {
    bearer: internalToken,
    body: { sessionId, ready: true },
  });
  const { id: jobId, leaseId } = polled.json.job;
  await request(context.internal, "/internal/job/ack", {
    bearer: internalToken,
    body: { sessionId, jobId, leaseId },
  });
  await request(context.internal, "/internal/heartbeat", {
    bearer: internalToken,
    body: { sessionId },
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  const result = await request(
    context.external,
    "/v1/jobs/result?requestId=request-watchdog",
    { bearer: context.bearer },
  );
  assert.equal(result.json.job.status, "failed");
  assert.equal(result.json.job.errorCode, "extension-unresponsive");
});

test("JobStore keeps strict FIFO and releases image input at terminal state", () => {
  let sequence = 0;
  const jobs = new JobStore({ idGenerator: () => `job-${++sequence}` });
  const image = Buffer.from("image").toString("base64");
  jobs.submit({
    requestId: "request-first",
    alias: "alpha",
    text: "first",
    images: [{ mediaType: "image/png", data: image }],
  });
  jobs.submit({ requestId: "request-second", alias: "alpha", text: "second", images: [] });
  const first = jobs.leaseNext("alpha");
  assert.equal(first.id, "job-1");
  jobs.acknowledge(first.id, first.leaseId);
  const done = jobs.complete(first.id, first.leaseId, { text: "answer" });
  assert.equal(done.text, "");
  assert.deepEqual(done.images, []);
  assert.equal(jobs.leaseNext("alpha").id, "job-2");
});
