import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  JobStore,
  RegistryError,
  SessionRegistry,
  newSessionId,
  parseProcStat,
  randomSecret,
  validateAlias,
  verifyBearer,
  verifyProcessOwnership,
} from "./registry.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config/kipsel/controller.json");
const LOOPBACK_HOST = "127.0.0.1";
const LIVE_STATUSES = new Set(["starting", "running", "stopping", "stale"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MEDIA_TYPE_RE = /^image\/(?:jpeg|png|webp|gif)$/;

export class ControllerError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "ControllerError";
    this.status = status;
    this.code = code;
  }
}

function parseIpv4(value) {
  if (typeof value !== "string") return null;
  const fields = value.split(".");
  if (fields.length !== 4 || fields.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = fields.map(Number);
  return numbers.some((number) => number > 255) ? null : numbers;
}

function ipv4Number(value) {
  const fields = parseIpv4(value);
  if (!fields) return null;
  return (
    ((fields[0] << 24) >>> 0) +
    ((fields[1] << 16) >>> 0) +
    ((fields[2] << 8) >>> 0) +
    fields[3]
  ) >>> 0;
}

function inCidr(address, cidr) {
  const [networkText, prefixText] = String(cidr).split("/");
  const addressNumber = ipv4Number(address);
  const networkNumber = ipv4Number(networkText);
  const prefix = Number(prefixText);
  if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (networkNumber & mask);
}

function normalizeRemoteAddress(value) {
  return typeof value === "string" && value.startsWith("::ffff:") ? value.slice(7) : value;
}

function isLoopback(value) {
  const address = normalizeRemoteAddress(value);
  return address === "::1" || address === "127.0.0.1";
}

function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const resolvedValue = value ?? fallback;
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue <= 0 || resolvedValue > maximum) {
    throw new ControllerError(500, "invalid-config", "A numeric controller limit is invalid");
  }
  return resolvedValue;
}

async function regularFile(path, label) {
  if (!isAbsolute(path)) throw new ControllerError(500, "invalid-config", `${label} must be absolute`);
  let information;
  try {
    information = await stat(path);
  } catch (error) {
    throw new ControllerError(500, "invalid-config", `${label} is unavailable`, { cause: error });
  }
  if (!information.isFile()) throw new ControllerError(500, "invalid-config", `${label} is not a file`);
  return path;
}

async function directory(path, label) {
  if (!isAbsolute(path)) throw new ControllerError(500, "invalid-config", `${label} must be absolute`);
  let information;
  try {
    information = await stat(path);
  } catch (error) {
    throw new ControllerError(500, "invalid-config", `${label} is unavailable`, { cause: error });
  }
  if (!information.isDirectory()) throw new ControllerError(500, "invalid-config", `${label} is not a directory`);
  return resolve(path);
}

function validName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name);
}

export async function loadConfig(path = process.env.KIPSEL_CONFIG || DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ControllerError(500, "invalid-config", "Unable to read controller configuration", {
      cause: error,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ControllerError(500, "invalid-config", "Controller configuration must be an object");
  }

  const externalHost = String(raw.external?.host ?? "");
  if (!inCidr(externalHost, "100.64.0.0/10")) {
    throw new ControllerError(500, "invalid-config", "External host must be a Tailscale IPv4 address");
  }
  const externalPort = raw.external?.port ?? 8787;
  const internalPort = raw.internal?.port ?? 8788;
  if (!validPort(externalPort) || !validPort(internalPort) || externalPort === internalPort) {
    throw new ControllerError(500, "invalid-config", "Controller ports are invalid");
  }
  const allowedSources = raw.external?.allowedSources;
  if (
    !Array.isArray(allowedSources) ||
    allowedSources.length === 0 ||
    allowedSources.some((source) => !parseIpv4(source) || !inCidr(source, "100.64.0.0/10"))
  ) {
    throw new ControllerError(500, "invalid-config", "External source allowlist is invalid");
  }
  const bearerSha256 = String(raw.external?.bearerSha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bearerSha256)) {
    throw new ControllerError(500, "invalid-config", "Bearer hash is invalid");
  }

  const statePath = String(raw.statePath ?? "");
  if (!isAbsolute(statePath) || statePath === "/") {
    throw new ControllerError(500, "invalid-config", "statePath must be an absolute file path");
  }
  const terminal = {
    executable: await regularFile(String(raw.terminal?.executable ?? "/usr/bin/xterm"), "terminal.executable"),
    piExecutable: await regularFile(String(raw.terminal?.piExecutable ?? ""), "terminal.piExecutable"),
    extensionPath: await regularFile(
      String(raw.terminal?.extensionPath ?? resolve(MODULE_DIR, "../tui-extension/index.ts")),
      "terminal.extensionPath",
    ),
    display: String(raw.terminal?.display ?? process.env.DISPLAY ?? ""),
    xauthority: await regularFile(
      String(raw.terminal?.xauthority ?? resolve(homedir(), ".Xauthority")),
      "terminal.xauthority",
    ),
  };
  if (!terminal.display) {
    throw new ControllerError(500, "invalid-config", "terminal.display is required");
  }

  const projects = {};
  if (!raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects)) {
    throw new ControllerError(500, "invalid-config", "projects must be an object");
  }
  for (const [name, projectPath] of Object.entries(raw.projects)) {
    if (!validName(name)) throw new ControllerError(500, "invalid-config", "A project name is invalid");
    projects[name] = await directory(String(projectPath), `projects.${name}`);
  }
  if (Object.keys(projects).length === 0) {
    throw new ControllerError(500, "invalid-config", "At least one project is required");
  }

  const profiles = {};
  if (!raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) {
    throw new ControllerError(500, "invalid-config", "profiles must be an object");
  }
  for (const [name, profile] of Object.entries(raw.profiles)) {
    if (!validName(name) || !profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new ControllerError(500, "invalid-config", "A profile is invalid");
    }
    const model = profile.model === undefined ? null : String(profile.model);
    if (model !== null && !/^[A-Za-z0-9._:/-]{1,160}$/.test(model)) {
      throw new ControllerError(500, "invalid-config", "A profile model is invalid");
    }
    profiles[name] = { model, vision: profile.vision === true };
  }
  if (Object.keys(profiles).length === 0) {
    throw new ControllerError(500, "invalid-config", "At least one profile is required");
  }

  const defaults = {
    project: String(raw.defaults?.project ?? Object.keys(projects)[0]),
    profile: String(raw.defaults?.profile ?? Object.keys(profiles)[0]),
  };
  if (!(defaults.project in projects) || !(defaults.profile in profiles)) {
    throw new ControllerError(500, "invalid-config", "Default project or profile is unknown");
  }

  const limits = {
    maxSessions: positiveInteger(raw.limits?.maxSessions, 3, 10),
    maxJobsPerAlias: positiveInteger(raw.limits?.maxJobsPerAlias, 20, 100),
    jobTtlMs: positiveInteger(raw.limits?.jobTtlMs, 30 * 60 * 1000),
    maxTextChars: positiveInteger(raw.limits?.maxTextChars, 100_000, 500_000),
    maxImageCount: positiveInteger(raw.limits?.maxImageCount, 3, 10),
    maxImageBytesPerImage: positiveInteger(raw.limits?.maxImageBytesPerImage, 5 * 1024 * 1024, 20 * 1024 * 1024),
    maxImageBytesTotal: positiveInteger(raw.limits?.maxImageBytesTotal, 8 * 1024 * 1024, 40 * 1024 * 1024),
    maxBodyBytes: positiveInteger(raw.limits?.maxBodyBytes, 12 * 1024 * 1024, 50 * 1024 * 1024),
    resultPollMs: positiveInteger(raw.limits?.resultPollMs, 25_000, 25_000),
    internalPollMs: positiveInteger(raw.limits?.internalPollMs, 25_000, 25_000),
    leaseAckMs: positiveInteger(raw.limits?.leaseAckMs, 30_000, 120_000),
    stopGraceMs: positiveInteger(raw.limits?.stopGraceMs, 15_000, 60_000),
    signalGraceMs: positiveInteger(raw.limits?.signalGraceMs, 3_000, 30_000),
    heartbeatTimeoutMs: positiveInteger(raw.limits?.heartbeatTimeoutMs, 60_000),
    watchdogIntervalMs: positiveInteger(raw.limits?.watchdogIntervalMs, 15_000),
  };

  return Object.freeze({
    configPath: path,
    external: { host: externalHost, port: externalPort, allowedSources: [...allowedSources], bearerSha256 },
    internal: { host: LOOPBACK_HOST, port: internalPort },
    statePath,
    terminal,
    projects: Object.freeze(projects),
    profiles: Object.freeze(profiles),
    defaults: Object.freeze(defaults),
    limits: Object.freeze(limits),
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

async function readJson(request, maxBytes) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    throw new ControllerError(415, "unsupported-media-type", "Expected application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new ControllerError(413, "payload-too-large", "Request body is too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ControllerError(413, "payload-too-large", "Request body is too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new ControllerError(400, "invalid-json", "Request body is invalid JSON");
  }
}

function publicSession(session, counts = {}) {
  return {
    alias: session.alias,
    sessionId: session.sessionId,
    project: session.project,
    profile: session.profile,
    status: session.status,
    pid: session.pid ?? null,
    startedAt: session.startedAt,
    lastHeartbeatAt: session.lastHeartbeatAt ?? null,
    queue: {
      queued: counts.queued ?? 0,
      active: (counts.leased ?? 0) + (counts.running ?? 0),
    },
  };
}

function publicJob(job) {
  return {
    id: job.id,
    requestId: job.requestId,
    alias: job.alias,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    resultText: job.resultText,
    interrupted: job.interrupted,
    errorCode: job.errorCode,
  };
}

function mappedError(error) {
  if (error instanceof ControllerError) return error;
  if (error instanceof RegistryError) {
    const statuses = {
      "invalid-alias": 400,
      "invalid-request": 400,
      "invalid-image": 400,
      "invalid-result": 400,
      "image-limit": 413,
      "image-too-large": 413,
      "image-total-too-large": 413,
      "request-conflict": 409,
      "invalid-job-state": 409,
      "lease-mismatch": 409,
      "queue-full": 429,
      "job-not-found": 404,
    };
    return new ControllerError(statuses[error.code] ?? 500, error.code, error.message);
  }
  return new ControllerError(500, "internal-error", "Internal controller error");
}

function extractBearer(request) {
  const match = /^Bearer ([^\s]+)$/i.exec(String(request.headers.authorization ?? ""));
  return match?.[1] ?? null;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function waitForServerListen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(100);
  }
  return !processAlive(pid);
}

async function readStartTime(pid, read = readFile) {
  try {
    return parseProcStat(await read(`/proc/${pid}/stat`, "utf8"))?.startTime ?? null;
  } catch {
    return null;
  }
}

function resolveProject(config, requested) {
  const name = requested === undefined ? config.defaults.project : String(requested);
  if (!(name in config.projects)) throw new ControllerError(400, "invalid-project", "Project is not allowed");
  return { name, cwd: config.projects[name] };
}

function resolveProfile(config, requested) {
  const name = requested === undefined ? config.defaults.profile : String(requested);
  if (!(name in config.profiles)) throw new ControllerError(400, "invalid-profile", "Profile is not allowed");
  return { name, ...config.profiles[name] };
}

export async function createController(config, dependencies = {}) {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const read = dependencies.readFile ?? readFile;
  const kill = dependencies.kill ?? process.kill.bind(process);
  const now = dependencies.now ?? Date.now;
  const registry = dependencies.registry ?? new SessionRegistry({ statePath: config.statePath });
  await registry.load();
  const jobs = dependencies.jobs ?? new JobStore({
    maxJobsPerAlias: config.limits.maxJobsPerAlias,
    ttlMs: config.limits.jobTtlMs,
    maxTextChars: config.limits.maxTextChars,
    maxImageCount: config.limits.maxImageCount,
    maxImageBytesPerImage: config.limits.maxImageBytesPerImage,
    maxImageBytesTotal: config.limits.maxImageBytesTotal,
    now,
  });

  const controls = new Map();
  const leaseTimers = new Map();
  const pollWaiters = new Map();
  const resultWaiters = new Map();
  const childProcesses = new Map();
  let stopping = false;
  let pruneTimer = null;
  let watchdogTimer = null;

  const wakePoll = (sessionId) => {
    const waiter = pollWaiters.get(sessionId);
    if (waiter) waiter();
  };
  const wakeResult = (jobId) => {
    const waiters = resultWaiters.get(jobId) ?? [];
    resultWaiters.delete(jobId);
    for (const waiter of waiters) waiter();
  };

  const liveSessions = () => registry.list().filter((session) => LIVE_STATUSES.has(session.status));

  async function markStopped(alias) {
    const record = registry.get(alias);
    if (!record || record.status === "stopped") return record;
    controls.delete(record.sessionId);
    pollWaiters.get(record.sessionId)?.();
    childProcesses.delete(alias);
    jobs.requeueLeases(alias);
    const active = jobs.getActive(alias);
    if (active?.status === "running") {
      jobs.fail(active.id, "session-ended", active.leaseId);
      wakeResult(active.id);
    }
    const stoppedRecord = {
      ...record,
      pid: null,
      startTime: null,
      ownerMarker: null,
      internalTokenHash: null,
      status: "stopped",
      lastHeartbeatAt: null,
    };
    registry.upsert(stoppedRecord);
    await registry.persist();
    return stoppedRecord;
  }

  async function reconcile() {
    for (const record of liveSessions()) {
      const ownership = await verifyProcessOwnership(record, { read });
      if (!ownership.owned) await markStopped(record.alias);
    }
  }
  await reconcile();

  function setControl(record, type, data = {}) {
    const current = controls.get(record.sessionId);
    if (current?.type === "shutdown" || current?.type === type) return current;
    const control = { id: newSessionId(), type, ...data };
    controls.set(record.sessionId, control);
    wakePoll(record.sessionId);
    return control;
  }

  let startQueue = Promise.resolve();
  function startSessionSerialized(body) {
    const run = startQueue.then(() => startSession(body));
    startQueue = run.catch(() => {});
    return run;
  }

  async function startSession(body) {
    const alias = String(body.alias ?? "");
    if (!validateAlias(alias)) throw new ControllerError(400, "invalid-alias", "alias is invalid");
    const project = resolveProject(config, body.project);
    const profile = resolveProfile(config, body.profile);
    const existing = registry.get(alias);
    if (existing && LIVE_STATUSES.has(existing.status)) {
      if (existing.cwd !== project.cwd || existing.profile !== profile.name) {
        throw new ControllerError(409, "session-conflict", "alias is already bound to another project or profile");
      }
      return existing;
    }
    if (existing && (existing.cwd !== project.cwd || existing.profile !== profile.name)) {
      throw new ControllerError(409, "session-conflict", "alias is bound to another project or profile");
    }
    if (liveSessions().length >= config.limits.maxSessions) {
      throw new ControllerError(429, "session-limit", "Visible TUI session limit reached");
    }

    const sessionId = existing?.sessionId ?? newSessionId();
    const ownerMarker = randomSecret(24);
    const internalToken = randomSecret(32);
    const internalTokenHash = createHash("sha256").update(internalToken).digest("hex");
    const args = [
      "-T",
      `KiPSel:${alias}`,
      "-e",
      config.terminal.piExecutable,
      "--session-id",
      sessionId,
      "--no-session",
      "--name",
      `KiPSel:${alias}`,
      "--extension",
      config.terminal.extensionPath,
      "--tui-mode",
      "regular",
    ];
    if (profile.model) args.push("--model", profile.model);

    const child = spawn(config.terminal.executable, args, {
      cwd: project.cwd,
      detached: true,
      env: {
        ...process.env,
        DISPLAY: config.terminal.display,
        XAUTHORITY: config.terminal.xauthority,
        KIPSEL_ALIAS: alias,
        KIPSEL_INTERNAL_TOKEN: internalToken,
        KIPSEL_INTERNAL_URL: `http://${config.internal.host}:${config.internal.port}`,
        KIPSEL_OWNER: ownerMarker,
        KIPSEL_SESSION_ID: sessionId,
      },
      stdio: "ignore",
    });
    if (!Number.isSafeInteger(child.pid)) {
      throw new ControllerError(503, "start-failed", "Unable to start the terminal");
    }
    child.unref?.();
    const startTime = await readStartTime(child.pid, read);
    if (!startTime) {
      try { kill(-child.pid, "SIGKILL"); } catch {}
      throw new ControllerError(503, "start-failed", "Unable to verify the terminal process");
    }

    const record = {
      alias,
      sessionId,
      pid: child.pid,
      startTime,
      ownerMarker,
      internalTokenHash,
      cwd: project.cwd,
      project: project.name,
      profile: profile.name,
      status: "starting",
      startedAt: new Date(now()).toISOString(),
      lastHeartbeatAt: null,
    };
    registry.upsert(record);
    try {
      await registry.persist();
    } catch (error) {
      const ownership = await verifyProcessOwnership(record, { read });
      if (ownership.owned) {
        try { kill(-record.pid, "SIGTERM"); } catch {}
      }
      registry.remove(alias);
      throw error;
    }
    childProcesses.set(alias, child);
    child.once?.("exit", () => void markStopped(alias));
    return record;
  }

  async function signalOwned(record, signalName) {
    const ownership = await verifyProcessOwnership(record, { read });
    if (!ownership.owned) return false;
    try {
      kill(-record.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw new ControllerError(500, "signal-failed", "Unable to signal the owned terminal");
    }
  }

  async function stopSession(body) {
    const alias = String(body.alias ?? "");
    const force = body.force === true;
    const record = registry.get(alias);
    if (!record) throw new ControllerError(404, "session-not-found", "Session was not found");
    if (record.status === "stopped") return record;
    const counts = jobs.listCounts()[alias] ?? {};
    const pendingCount = (counts.queued ?? 0) + (counts.leased ?? 0) + (counts.running ?? 0);
    if (pendingCount > 0 && !force) {
      throw new ControllerError(409, "session-busy", "Session has active or queued work");
    }
    if (force) {
      jobs.cancelAlias(alias, { includeActive: true });
      setControl(record, "shutdown", { force: true });
    } else {
      setControl(record, "shutdown", { force: false });
    }
    registry.upsert({ ...record, status: "stopping" });
    await registry.persist();

    if (await waitForExit(record.pid, config.limits.stopGraceMs)) return markStopped(alias);
    const current = registry.get(alias);
    if (!current || !(await signalOwned(current, "SIGTERM"))) {
      if (!processAlive(record.pid)) return markStopped(alias);
      throw new ControllerError(409, "ownership-mismatch", "Refusing to stop a non-owned process");
    }
    if (!(await waitForExit(current.pid, config.limits.signalGraceMs))) {
      const latest = registry.get(alias);
      if (latest && (await signalOwned(latest, "SIGKILL"))) {
        await waitForExit(latest.pid, 1_000);
      }
    }
    if (processAlive(current.pid)) {
      throw new ControllerError(503, "stop-timeout", "Owned terminal did not stop");
    }
    return markStopped(alias);
  }

  async function abortSession(body) {
    const alias = String(body.alias ?? "");
    const record = registry.get(alias);
    if (!record || !LIVE_STATUSES.has(record.status)) {
      throw new ControllerError(404, "session-not-found", "Running session was not found");
    }
    const active = jobs.getActive(alias);
    setControl(record, "abort", { jobId: active?.id ?? null });
    return { alias, jobId: active?.id ?? null };
  }

  function authenticateExternal(request) {
    const address = normalizeRemoteAddress(request.socket.remoteAddress ?? "");
    if (!config.external.allowedSources.includes(address)) {
      throw new ControllerError(403, "forbidden", "Source is not allowed");
    }
    if (!verifyBearer(extractBearer(request), config.external.bearerSha256)) {
      throw new ControllerError(401, "unauthorized", "Bearer authentication failed");
    }
  }

  function authenticateInternal(request, body) {
    if (!isLoopback(request.socket.remoteAddress ?? "")) {
      throw new ControllerError(403, "forbidden", "Internal API is loopback-only");
    }
    const sessionId = String(body.sessionId ?? "");
    const record = registry.list().find((session) => session.sessionId === sessionId);
    if (!record || !LIVE_STATUSES.has(record.status)) {
      throw new ControllerError(401, "unauthorized", "Internal session authentication failed");
    }
    const candidate = extractBearer(request);
    if (!verifyBearer(candidate, record.internalTokenHash)) {
      throw new ControllerError(401, "unauthorized", "Internal session authentication failed");
    }
    return record;
  }

  async function waitForPoll(record, ready, currentJobId) {
    const deliver = () => {
      const control = controls.get(record.sessionId);
      if (control) return { kind: "control", control };
      const active = jobs.resumeActive(record.alias);
      if (active && active.id !== currentJobId) {
        return {
          kind: "resume",
          job: {
            id: active.id,
            leaseId: active.leaseId,
            text: active.text,
            images: active.images,
          },
        };
      }
      if (!ready) return null;
      const job = jobs.leaseNext(record.alias);
      if (!job) return null;
      const leaseKey = `${job.id}:${job.leaseId}`;
      const timer = setTimeout(() => {
        leaseTimers.delete(leaseKey);
        if (jobs.requeueLease(job.id, job.leaseId)) wakePoll(record.sessionId);
      }, config.limits.leaseAckMs);
      timer.unref();
      leaseTimers.set(leaseKey, timer);
      return {
        kind: "job",
        job: {
          id: job.id,
          leaseId: job.leaseId,
          text: job.text,
          images: job.images,
        },
      };
    };
    const immediate = deliver();
    if (immediate) return immediate;
    await new Promise((resolvePromise) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        pollWaiters.delete(record.sessionId);
        resolvePromise();
      };
      const timer = setTimeout(finish, config.limits.internalPollMs);
      pollWaiters.set(record.sessionId, finish);
    });
    return deliver() ?? { kind: "idle" };
  }

  async function waitForResult(job) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    await new Promise((resolvePromise) => {
      const waiters = resultWaiters.get(job.id) ?? [];
      resultWaiters.set(job.id, waiters);
      const timer = setTimeout(() => {
        const current = resultWaiters.get(job.id) ?? [];
        resultWaiters.set(job.id, current.filter((item) => item !== finish));
        resolvePromise();
      }, config.limits.resultPollMs);
      const finish = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      waiters.push(finish);
    });
    return jobs.get(job.id);
  }

  async function handleExternal(request, response) {
    authenticateExternal(request);
    const url = new URL(request.url ?? "/", "http://controller.invalid");
    const route = `${request.method} ${url.pathname}`;
    const counts = jobs.listCounts();

    if (route === "GET /v1/health") {
      return sendJson(response, 200, { ok: true, sessions: liveSessions().length });
    }
    if (route === "GET /v1/projects") {
      return sendJson(response, 200, {
        projects: Object.keys(config.projects),
        profiles: Object.entries(config.profiles).map(([name, profile]) => ({ name, vision: profile.vision })),
        defaults: config.defaults,
      });
    }
    if (route === "GET /v1/sessions") {
      return sendJson(response, 200, {
        sessions: registry.list().map((session) => publicSession(session, counts[session.alias])),
      });
    }
    if (route === "GET /v1/jobs/result") {
      const requestId = String(url.searchParams.get("requestId") ?? "");
      const job = jobs.getByRequestId(requestId);
      if (!job) throw new ControllerError(404, "job-not-found", "Job was not found");
      return sendJson(response, 200, { job: publicJob(await waitForResult(job)) });
    }

    const body =
      request.method === "POST" ? await readJson(request, config.limits.maxBodyBytes) : {};
    if (route === "POST /v1/sessions/start") {
      const record = await startSessionSerialized(body);
      return sendJson(response, 200, { session: publicSession(record, jobs.listCounts()[record.alias]) });
    }
    if (route === "POST /v1/sessions/stop") {
      const record = await stopSession(body);
      return sendJson(response, 200, { session: publicSession(record, jobs.listCounts()[record.alias]) });
    }
    if (route === "POST /v1/sessions/abort") {
      return sendJson(response, 200, await abortSession(body));
    }
    if (route === "POST /v1/jobs") {
      const record = registry.get(String(body.alias ?? ""));
      if (!record || !LIVE_STATUSES.has(record.status)) {
        throw new ControllerError(404, "session-not-found", "Running session was not found");
      }
      if (Array.isArray(body.images) && body.images.length > 0 && !config.profiles[record.profile]?.vision) {
        throw new ControllerError(409, "vision-required", "The selected session profile does not accept images");
      }
      const job = jobs.submit(body);
      wakePoll(record.sessionId);
      return sendJson(response, 200, { job: publicJob(job) });
    }
    if (route === "POST /v1/jobs/cancel") {
      const job = jobs.getByRequestId(String(body.requestId ?? ""));
      if (!job) throw new ControllerError(404, "job-not-found", "Job was not found");
      const cancelled = jobs.cancel(job.id);
      if (job.status === "running") {
        const record = registry.get(job.alias);
        if (record) setControl(record, "abort", { jobId: job.id });
      }
      wakeResult(job.id);
      return sendJson(response, 200, { job: publicJob(cancelled) });
    }
    throw new ControllerError(404, "not-found", "Route was not found");
  }

  async function handleInternal(request, response) {
    const body = await readJson(request, config.limits.maxBodyBytes);
    const record = authenticateInternal(request, body);
    const route = `${request.method} ${new URL(request.url ?? "/", "http://internal.invalid").pathname}`;

    if (route === "POST /internal/poll") {
      return sendJson(
        response,
        200,
        await waitForPoll(
          record,
          body.ready === true,
          typeof body.currentJobId === "string" ? body.currentJobId : null,
        ),
      );
    }
    if (route === "POST /internal/job/ack") {
      const candidate = jobs.get(String(body.jobId ?? ""));
      if (!candidate || candidate.alias !== record.alias) {
        throw new ControllerError(403, "forbidden", "Job belongs to another session");
      }
      const job = jobs.acknowledge(candidate.id, String(body.leaseId ?? ""));
      const leaseKey = `${job.id}:${body.leaseId}`;
      clearTimeout(leaseTimers.get(leaseKey));
      leaseTimers.delete(leaseKey);
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /internal/job/result") {
      const current = jobs.get(String(body.jobId ?? ""));
      if (!current || current.alias !== record.alias) {
        throw new ControllerError(403, "forbidden", "Job belongs to another session");
      }
      const job = jobs.complete(current.id, String(body.leaseId ?? ""), {
        text: typeof body.text === "string" ? body.text : "",
        interrupted: body.interrupted === true,
      });
      wakeResult(job.id);
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /internal/job/fail") {
      const current = jobs.get(String(body.jobId ?? ""));
      if (!current || current.alias !== record.alias) {
        throw new ControllerError(403, "forbidden", "Job belongs to another session");
      }
      const job = jobs.fail(current.id, String(body.code ?? "extension-error"), String(body.leaseId ?? ""));
      wakeResult(job.id);
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /internal/control/ack") {
      const control = controls.get(record.sessionId);
      if (control?.id === body.controlId) controls.delete(record.sessionId);
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /internal/heartbeat") {
      registry.upsert({
        ...record,
        status: record.status === "starting" ? "running" : record.status,
        lastHeartbeatAt: new Date(now()).toISOString(),
      });
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /internal/end") {
      await markStopped(record.alias);
      return sendJson(response, 200, { ok: true });
    }
    throw new ControllerError(404, "not-found", "Route was not found");
  }

  function requestHandler(handler) {
    return async (request, response) => {
      try {
        await handler(request, response);
      } catch (error) {
        const mapped = mappedError(error);
        if (!response.headersSent) sendJson(response, mapped.status, { error: mapped.code, message: mapped.message });
        else response.destroy();
      }
    };
  }

  const externalServer = createServer(requestHandler(handleExternal));
  const internalServer = createServer(requestHandler(handleInternal));
  for (const server of [externalServer, internalServer]) {
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
  }

  async function start() {
    await waitForServerListen(internalServer, config.internal.port, config.internal.host);
    try {
      await waitForServerListen(externalServer, config.external.port, config.external.host);
    } catch (error) {
      await closeServer(internalServer);
      throw error;
    }
    pruneTimer = setInterval(() => jobs.prune(), 60_000);
    pruneTimer.unref();
    watchdogTimer = setInterval(() => {
      const nowMs = now();
      for (const record of liveSessions()) {
        if (record.status !== "running" || !record.lastHeartbeatAt) continue;
        if (nowMs - Date.parse(record.lastHeartbeatAt) <= config.limits.heartbeatTimeoutMs) {
          continue;
        }
        const active = jobs.getActive(record.alias);
        if (active?.status === "running") {
          jobs.fail(active.id, "extension-unresponsive", active.leaseId);
          wakeResult(active.id);
        }
      }
    }, config.limits.watchdogIntervalMs);
    watchdogTimer.unref();
    return {
      external: externalServer.address(),
      internal: internalServer.address(),
    };
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (pruneTimer) clearInterval(pruneTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    for (const timer of leaseTimers.values()) clearTimeout(timer);
    for (const finish of pollWaiters.values()) finish();
    for (const waiters of resultWaiters.values()) for (const finish of waiters) finish();
    await Promise.allSettled([closeServer(externalServer), closeServer(internalServer)]);
    await registry.persist();
  }

  return {
    config,
    externalServer,
    internalServer,
    jobs,
    registry,
    start,
    stop,
  };
}

export async function main() {
  const config = await loadConfig();
  const controller = await createController(config);
  await controller.start();
  let ending = false;
  const shutdown = async () => {
    if (ending) return;
    ending = true;
    await controller.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return controller;
}

const isEntryPoint = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) {
  main().catch((error) => {
    const mapped = mappedError(error);
    process.stderr.write(`KiPSel controller failed: ${mapped.code}\n`);
    process.exitCode = 1;
  });
}
