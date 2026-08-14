import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const ALLOWED_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export class RegistryError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RegistryError";
    this.code = code;
  }
}

export function validateAlias(alias) {
  return typeof alias === "string" && ALIAS_RE.test(alias);
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function newSessionId() {
  return randomUUID();
}

export function verifyBearer(candidate, expectedSha256Hex) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    typeof expectedSha256Hex !== "string" ||
    !/^[0-9a-f]{64}$/i.test(expectedSha256Hex)
  ) {
    return false;
  }
  const expected = Buffer.from(expectedSha256Hex, "hex");
  const actual = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(actual, expected);
}

export function parseProcStat(text) {
  if (typeof text !== "string") return null;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close <= open) return null;
  const pid = Number.parseInt(text.slice(0, open).trim(), 10);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (!Number.isSafeInteger(pid) || pid <= 0 || fields.length < 20) return null;
  return {
    pid,
    comm: text.slice(open + 1, close),
    state: fields[0],
    ppid: Number.parseInt(fields[1], 10),
    pgrp: Number.parseInt(fields[2], 10),
    session: Number.parseInt(fields[3], 10),
    startTime: fields[19],
  };
}

export function parseProcEnviron(text) {
  const result = new Map();
  if (typeof text !== "string") return result;
  for (const item of text.split("\0")) {
    const separator = item.indexOf("=");
    if (separator > 0) result.set(item.slice(0, separator), item.slice(separator + 1));
  }
  return result;
}

export function parseProcCmdline(text) {
  return typeof text === "string" ? text.split("\0").filter(Boolean) : [];
}

export function assessProcessOwnership(
  { statText, environText, cmdlineText },
  { pid, startTime, sessionId, ownerMarker },
) {
  const stat = parseProcStat(statText);
  if (!stat) return { owned: false, reason: "stat-unavailable" };
  if (String(stat.pid) !== String(pid)) return { owned: false, reason: "pid-mismatch" };
  if (String(stat.startTime) !== String(startTime)) {
    return { owned: false, reason: "starttime-mismatch" };
  }

  const environment = parseProcEnviron(environText);
  if (environment.get("KIPSEL_OWNER") !== ownerMarker) {
    return { owned: false, reason: "owner-marker-mismatch" };
  }
  if (environment.get("KIPSEL_SESSION_ID") !== sessionId) {
    return { owned: false, reason: "session-id-mismatch" };
  }

  const argumentsList = parseProcCmdline(cmdlineText);
  const sessionIndex = argumentsList.findIndex((value) => value === "--session-id");
  if (sessionIndex < 0 || argumentsList[sessionIndex + 1] !== sessionId) {
    return { owned: false, reason: "cmdline-mismatch" };
  }
  return { owned: true, reason: "ok" };
}

async function safeProcRead(read, path) {
  try {
    const value = await read(path);
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  } catch {
    return null;
  }
}

export async function verifyProcessOwnership(record, { read = readFile } = {}) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    return { owned: false, reason: "not-running" };
  }
  const base = `/proc/${record.pid}`;
  const [statText, environText, cmdlineText] = await Promise.all([
    safeProcRead(read, `${base}/stat`),
    safeProcRead(read, `${base}/environ`),
    safeProcRead(read, `${base}/cmdline`),
  ]);
  if (statText === null || environText === null || cmdlineText === null) {
    return { owned: false, reason: "proc-unavailable" };
  }
  return assessProcessOwnership(
    { statText, environText, cmdlineText },
    record,
  );
}

const SESSION_KEYS = Object.freeze([
  "alias",
  "sessionId",
  "pid",
  "startTime",
  "ownerMarker",
  "internalTokenHash",
  "cwd",
  "project",
  "profile",
  "status",
  "startedAt",
  "lastHeartbeatAt",
]);
const SESSION_STATUSES = new Set(["starting", "running", "stopping", "stopped", "stale"]);
const LIVE_SESSION_STATUSES = new Set(["starting", "running", "stopping", "stale"]);

function copySession(record) {
  return record ? structuredClone(record) : null;
}

function sanitizeSession(input) {
  const record = {};
  for (const key of SESSION_KEYS) {
    if (input[key] !== undefined) record[key] = input[key];
  }
  return record;
}

function validSessionRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (!validateAlias(record.alias)) return false;
  if (typeof record.sessionId !== "string" || record.sessionId.length < 8) return false;
  if (typeof record.cwd !== "string" || record.cwd.length === 0) return false;
  if (typeof record.project !== "string" || record.project.length === 0) return false;
  if (typeof record.profile !== "string" || record.profile.length === 0) return false;
  if (!SESSION_STATUSES.has(record.status)) return false;
  if (typeof record.startedAt !== "string") return false;

  if (LIVE_SESSION_STATUSES.has(record.status)) {
    return (
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      typeof record.startTime === "string" &&
      record.startTime.length > 0 &&
      typeof record.ownerMarker === "string" &&
      record.ownerMarker.length >= 16 &&
      typeof record.internalTokenHash === "string" &&
      /^[0-9a-f]{64}$/.test(record.internalTokenHash)
    );
  }
  return (
    (record.pid === null || record.pid === undefined) &&
    (record.startTime === null || record.startTime === undefined) &&
    (record.ownerMarker === null || record.ownerMarker === undefined) &&
    (record.internalTokenHash === null || record.internalTokenHash === undefined)
  );
}

const DEFAULT_FS = Object.freeze({ mkdir, readFile, rename, unlink, writeFile });

export class SessionRegistry {
  constructor({ statePath, fsImpl = {} } = {}) {
    if (typeof statePath !== "string" || statePath.length === 0) {
      throw new RegistryError("invalid-config", "statePath is required");
    }
    this.statePath = statePath;
    this.fs = { ...DEFAULT_FS, ...fsImpl };
    this.sessions = new Map();
  }

  async load() {
    let source;
    try {
      source = await this.fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return this;
      throw new RegistryError("state-read-error", "Unable to read controller state", {
        cause: error,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new RegistryError("state-corrupt", "Controller state is not valid JSON", {
        cause: error,
      });
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new RegistryError("state-corrupt", "Controller state has an unsupported shape");
    }

    const next = new Map();
    for (const input of parsed.sessions) {
      const record = sanitizeSession(input);
      if (!validSessionRecord(record) || next.has(record.alias)) {
        throw new RegistryError("state-corrupt", "Controller state contains an invalid session");
      }
      next.set(record.alias, record);
    }
    this.sessions = next;
    return this;
  }

  async persist() {
    const parent = dirname(this.statePath);
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = `${JSON.stringify(
      {
        version: 1,
        sessions: [...this.sessions.values()].sort((left, right) =>
          left.alias.localeCompare(right.alias),
        ),
      },
      null,
      2,
    )}\n`;
    try {
      await this.fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await this.fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await this.fs.rename(temporary, this.statePath);
    } catch (error) {
      await this.fs.unlink(temporary).catch(() => {});
      throw new RegistryError("state-write-error", "Unable to persist controller state", {
        cause: error,
      });
    }
  }

  upsert(input) {
    const record = sanitizeSession(input ?? {});
    if (!validSessionRecord(record)) {
      throw new RegistryError("invalid-session", "Session record is invalid");
    }
    this.sessions.set(record.alias, record);
    return copySession(record);
  }

  get(alias) {
    return copySession(this.sessions.get(alias));
  }

  list() {
    return [...this.sessions.values()]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map(copySession);
  }

  remove(alias) {
    return this.sessions.delete(alias);
  }
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value;
}

function releaseInput(job) {
  job.text = "";
  job.images = [];
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_JOB_STATUSES = new Set(["leased", "running"]);

export class JobStore {
  constructor({
    maxJobsPerAlias = 20,
    ttlMs = 30 * 60 * 1000,
    maxTextChars = 100_000,
    maxImageCount = 3,
    maxImageBytesPerImage = 5 * 1024 * 1024,
    maxImageBytesTotal = 8 * 1024 * 1024,
    now = Date.now,
    idGenerator = randomUUID,
  } = {}) {
    this.maxJobsPerAlias = maxJobsPerAlias;
    this.ttlMs = ttlMs;
    this.maxTextChars = maxTextChars;
    this.maxImageCount = maxImageCount;
    this.maxImageBytesPerImage = maxImageBytesPerImage;
    this.maxImageBytesTotal = maxImageBytesTotal;
    this.now = now;
    this.idGenerator = idGenerator;
    this.jobs = new Map();
    this.requestIds = new Map();
    this.sequence = 0;
  }

  validateImages(images) {
    if (!Array.isArray(images) || images.length > this.maxImageCount) {
      throw new RegistryError("image-limit", "Image count exceeds the configured limit");
    }
    let totalBytes = 0;
    return images.map((image) => {
      if (
        !image ||
        !ALLOWED_IMAGE_TYPES.includes(image.mediaType) ||
        !canonicalBase64(image.data)
      ) {
        throw new RegistryError("invalid-image", "Image payload is invalid");
      }
      const bytes = Buffer.from(image.data, "base64").length;
      if (bytes > this.maxImageBytesPerImage) {
        throw new RegistryError("image-too-large", "An image exceeds the configured limit");
      }
      totalBytes += bytes;
      if (totalBytes > this.maxImageBytesTotal) {
        throw new RegistryError("image-total-too-large", "Images exceed the configured total limit");
      }
      return { mediaType: image.mediaType, data: image.data };
    });
  }

  submit({ requestId, alias, text = "", images = [] } = {}) {
    if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 128) {
      throw new RegistryError("invalid-request", "requestId is invalid");
    }
    if (!validateAlias(alias)) throw new RegistryError("invalid-alias", "alias is invalid");
    if (typeof text !== "string" || text.length > this.maxTextChars) {
      throw new RegistryError("invalid-request", "Prompt text is invalid");
    }
    const acceptedImages = this.validateImages(images);
    if (text.trim().length === 0 && acceptedImages.length === 0) {
      throw new RegistryError("invalid-request", "A prompt or image is required");
    }

    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ alias, text, images: acceptedImages }))
      .digest("hex");
    const existingId = this.requestIds.get(requestId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing?.payloadHash === payloadHash) return structuredClone(existing);
      throw new RegistryError("request-conflict", "requestId was reused with another payload");
    }

    const queued = [...this.jobs.values()].filter(
      (job) => job.alias === alias && job.status === "queued",
    ).length;
    if (queued >= this.maxJobsPerAlias) {
      throw new RegistryError("queue-full", "The alias queue is full");
    }

    const timestamp = this.now();
    const job = {
      id: this.idGenerator(),
      requestId,
      alias,
      text,
      images: acceptedImages,
      payloadHash,
      status: "queued",
      sequence: ++this.sequence,
      createdAt: timestamp,
      updatedAt: timestamp,
      resultText: null,
      interrupted: false,
      errorCode: null,
    };
    this.jobs.set(job.id, job);
    this.requestIds.set(requestId, job.id);
    return structuredClone(job);
  }

  leaseNext(alias) {
    const next = [...this.jobs.values()]
      .filter((job) => job.alias === alias && job.status === "queued")
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!next) return null;
    next.status = "leased";
    next.leaseId = randomSecret(18);
    next.updatedAt = this.now();
    return structuredClone(next);
  }

  acknowledge(jobId, leaseId) {
    const job = this.require(jobId);
    if (job.status === "running" && job.leaseId === leaseId) {
      return structuredClone(job);
    }
    if (job.status !== "leased" || job.leaseId !== leaseId) {
      throw new RegistryError("lease-mismatch", "Job lease is invalid");
    }
    job.status = "running";
    job.updatedAt = this.now();
    return structuredClone(job);
  }

  complete(jobId, leaseId, { text, interrupted = false } = {}) {
    const job = this.require(jobId);
    if (job.status !== "running" || job.leaseId !== leaseId) {
      throw new RegistryError("lease-mismatch", "Only the running lease can complete a job");
    }
    if (typeof text !== "string") {
      throw new RegistryError("invalid-result", "Result text is invalid");
    }
    job.status = "completed";
    job.resultText = text;
    job.interrupted = Boolean(interrupted);
    job.updatedAt = this.now();
    delete job.leaseId;
    releaseInput(job);
    return structuredClone(job);
  }

  fail(jobId, code = "job-failed", leaseId = null) {
    const job = this.require(jobId);
    if (ACTIVE_JOB_STATUSES.has(job.status) && job.leaseId !== leaseId) {
      throw new RegistryError("lease-mismatch", "Only the active lease can fail a job");
    }
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      return structuredClone(job);
    }
    job.status = "failed";
    job.errorCode = typeof code === "string" && code.length <= 64 ? code : "job-failed";
    job.updatedAt = this.now();
    delete job.leaseId;
    releaseInput(job);
    return structuredClone(job);
  }

  cancel(jobId) {
    const job = this.require(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return structuredClone(job);
    job.status = "cancelled";
    job.updatedAt = this.now();
    delete job.leaseId;
    releaseInput(job);
    return structuredClone(job);
  }

  cancelAlias(alias, { includeActive = false } = {}) {
    const cancelled = [];
    for (const job of this.jobs.values()) {
      if (job.alias !== alias || TERMINAL_JOB_STATUSES.has(job.status)) continue;
      if (!includeActive && ACTIVE_JOB_STATUSES.has(job.status)) continue;
      cancelled.push(this.cancel(job.id).id);
    }
    return cancelled;
  }

  require(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new RegistryError("job-not-found", "Job was not found");
    return job;
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  getByRequestId(requestId) {
    const jobId = this.requestIds.get(requestId);
    return jobId ? this.get(jobId) : null;
  }

  getActive(alias) {
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.alias === alias && ACTIVE_JOB_STATUSES.has(candidate.status))
      .sort((left, right) => left.sequence - right.sequence)[0];
    return job ? structuredClone(job) : null;
  }

  resumeActive(alias) {
    const job = this.getActive(alias);
    if (!job || job.status !== "running") return null;
    return job;
  }

  requeueLease(jobId, leaseId) {
    const job = this.require(jobId);
    if (job.status !== "leased" || job.leaseId !== leaseId) return false;
    job.status = "queued";
    delete job.leaseId;
    job.updatedAt = this.now();
    return true;
  }

  requeueLeases(alias) {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.alias === alias && job.status === "leased") {
        job.status = "queued";
        delete job.leaseId;
        job.updatedAt = this.now();
        count += 1;
      }
    }
    return count;
  }

  listCounts() {
    const byAlias = {};
    for (const job of this.jobs.values()) {
      const counts = (byAlias[job.alias] ??= {
        queued: 0,
        leased: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      });
      counts[job.status] += 1;
    }
    return byAlias;
  }

  prune(timestamp = this.now()) {
    let removed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "queued" && timestamp - job.createdAt > this.ttlMs) {
        this.cancel(job.id);
      }
    }
    for (const [jobId, job] of this.jobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status) && timestamp - job.updatedAt > this.ttlMs) {
        this.jobs.delete(jobId);
        this.requestIds.delete(job.requestId);
        removed += 1;
      }
    }
    return removed;
  }
}
