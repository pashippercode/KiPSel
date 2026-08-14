export const MARKER_TYPE = "kipsel-job";

export const LIMITS = Object.freeze({
  maxTextChars: 100_000,
  maxImageCount: 3,
  maxImageBytesPerImage: 5 * 1024 * 1024,
  maxImageBytesTotal: 8 * 1024 * 1024,
});

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_URL_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface RuntimeConfig {
  internalUrl: string;
  alias: string;
  sessionId: string;
  token: string;
}

export interface JobImage {
  mediaType: string;
  data: string;
}

export interface JobPayload {
  id: string;
  leaseId: string;
  text: string;
  images: JobImage[];
}

export type UserContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface SessionEntryLike {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  };
}

export interface HarvestResult {
  status: "pending" | "done" | "interrupted" | "error";
  jobId: string;
  text: string | null;
  stopReason: string | null;
  errorCode: string | null;
  interrupted: boolean;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

function failure<T>(code: string, message: string): ParseResult<T> {
  return { ok: false, code, message };
}

export function parseRuntimeConfig(
  environment: Record<string, string | undefined>,
): ParseResult<RuntimeConfig> {
  const internalUrl = environment.KIPSEL_INTERNAL_URL;
  const alias = environment.KIPSEL_ALIAS;
  const sessionId = environment.KIPSEL_SESSION_ID;
  const token = environment.KIPSEL_INTERNAL_TOKEN;

  const urlMatch = INTERNAL_URL_RE.exec(internalUrl ?? "");
  const port = Number(urlMatch?.[1]);
  if (!urlMatch || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return failure("invalid-internal-url", "KIPSEL_INTERNAL_URL must use loopback HTTP");
  }
  if (!ALIAS_RE.test(alias ?? "")) {
    return failure("invalid-alias", "KIPSEL_ALIAS is invalid");
  }
  if (!SESSION_ID_RE.test(sessionId ?? "")) {
    return failure("invalid-session-id", "KIPSEL_SESSION_ID is invalid");
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    return failure("invalid-internal-token", "KIPSEL_INTERNAL_TOKEN is invalid");
  }
  return {
    ok: true,
    value: { internalUrl: internalUrl!, alias: alias!, sessionId: sessionId!, token },
  };
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return BASE64_RE.test(value) && Buffer.from(value, "base64").toString("base64") === value;
}

export function validateJobPayload(payload: unknown): ParseResult<JobPayload> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failure("invalid-job", "Job payload must be an object");
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length < 8 || candidate.id.length > 128) {
    return failure("invalid-job", "Job id is invalid");
  }
  if (
    typeof candidate.leaseId !== "string" ||
    candidate.leaseId.length < 8 ||
    candidate.leaseId.length > 256
  ) {
    return failure("invalid-job", "Job lease is invalid");
  }
  if (typeof candidate.text !== "string" || candidate.text.length > LIMITS.maxTextChars) {
    return failure("invalid-job", "Job text is invalid");
  }
  if (!Array.isArray(candidate.images) || candidate.images.length > LIMITS.maxImageCount) {
    return failure("image-limit", "Job image count is invalid");
  }

  const images: JobImage[] = [];
  let totalBytes = 0;
  for (const input of candidate.images) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return failure("invalid-image", "Image payload is invalid");
    }
    const image = input as Record<string, unknown>;
    if (typeof image.mediaType !== "string" || !IMAGE_TYPES.has(image.mediaType)) {
      return failure("invalid-image", "Image media type is not allowed");
    }
    if (!canonicalBase64(image.data)) {
      return failure("invalid-image", "Image data is not canonical base64");
    }
    const byteLength = Buffer.from(image.data, "base64").length;
    if (byteLength > LIMITS.maxImageBytesPerImage) {
      return failure("image-too-large", "An image exceeds the byte limit");
    }
    totalBytes += byteLength;
    if (totalBytes > LIMITS.maxImageBytesTotal) {
      return failure("image-total-too-large", "Images exceed the total byte limit");
    }
    images.push({ mediaType: image.mediaType, data: image.data });
  }
  if (candidate.text.trim().length === 0 && images.length === 0) {
    return failure("empty-job", "A prompt or image is required");
  }
  return {
    ok: true,
    value: {
      id: candidate.id,
      leaseId: candidate.leaseId,
      text: candidate.text,
      images,
    },
  };
}

export function toUserContent(job: JobPayload): UserContent[] {
  const content: UserContent[] = [];
  if (job.text.length > 0) content.push({ type: "text", text: job.text });
  for (const image of job.images) {
    content.push({ type: "image", data: image.data, mimeType: image.mediaType });
  }
  return content;
}

export function makeMarkerData(jobId: string): { jobId: string } {
  return { jobId };
}

function markerMatches(entry: SessionEntryLike, jobId: string): boolean {
  if (entry.type !== "custom" || entry.customType !== MARKER_TYPE) return false;
  const data = entry.data as { jobId?: unknown } | undefined;
  return data?.jobId === jobId;
}

export function findMarker(
  entries: readonly SessionEntryLike[],
  jobId: string,
): SessionEntryLike | undefined {
  let match: SessionEntryLike | undefined;
  for (const entry of entries) if (markerMatches(entry, jobId)) match = entry;
  return match;
}

function isRole(entry: SessionEntryLike, role: string): boolean {
  return entry.type === "message" && entry.message?.role === role;
}

export function hasUserAfterMarker(entries: readonly SessionEntryLike[], jobId: string): boolean {
  let markerIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (markerMatches(entries[index], jobId)) markerIndex = index;
  }
  if (markerIndex < 0) return false;
  return entries.slice(markerIndex + 1).some((entry) => isRole(entry, "user"));
}

function textFromAssistant(entry: SessionEntryLike): string {
  if (!isRole(entry, "assistant") || !Array.isArray(entry.message?.content)) return "";
  return entry.message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(
          block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        ),
    )
    .map((block) => block.text)
    .join("");
}

function pending(jobId: string): HarvestResult {
  return {
    status: "pending",
    jobId,
    text: null,
    stopReason: null,
    errorCode: null,
    interrupted: false,
  };
}

export function harvestResult(
  entries: readonly SessionEntryLike[],
  jobId: string,
): HarvestResult {
  let markerIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (markerMatches(entries[index], jobId)) markerIndex = index;
  }
  if (markerIndex < 0) return pending(jobId);

  let targetUserIndex = -1;
  let boundaryIndex = entries.length;
  for (let index = markerIndex + 1; index < entries.length; index += 1) {
    if (!isRole(entries[index], "user")) continue;
    if (targetUserIndex < 0) targetUserIndex = index;
    else {
      boundaryIndex = index;
      break;
    }
  }
  if (targetUserIndex < 0) return pending(jobId);

  let assistant: SessionEntryLike | null = null;
  let text = "";
  for (let index = targetUserIndex + 1; index < boundaryIndex; index += 1) {
    const candidateText = textFromAssistant(entries[index]);
    if (candidateText.length > 0) {
      assistant = entries[index];
      text = candidateText;
    }
  }
  if (!assistant) return pending(jobId);

  const stopReason = String(assistant.message?.stopReason ?? "pending");
  if (stopReason === "pending" || stopReason === "toolUse" || stopReason === "deferred") {
    return pending(jobId);
  }
  if (stopReason === "error") {
    return {
      status: "error",
      jobId,
      text,
      stopReason,
      errorCode: "assistant-error",
      interrupted: false,
    };
  }
  const interrupted = boundaryIndex < entries.length || stopReason === "aborted";
  return {
    status: interrupted ? "interrupted" : "done",
    jobId,
    text,
    stopReason,
    errorCode: null,
    interrupted,
  };
}

export function backoffDelay(attempt: number, baseMs = 250, maximumMs = 10_000): number {
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(Math.max(1, baseMs) * 2 ** exponent, Math.max(1, maximumMs));
}

export function sleepAbortable(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, milliseconds));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
