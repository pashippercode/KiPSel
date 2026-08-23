import { isIP } from "node:net";

export const TAVILY_LIMITS = Object.freeze({
  maxQueryChars: 1_000,
  maxResults: 10,
  maxResponseBytes: 512 * 1024,
  maxAnswerChars: 8_000,
  maxTitleChars: 512,
  maxUrlChars: 2_048,
  maxContentChars: 8_000,
  maxPublishedDateChars: 128,
  defaultResults: 5,
  maxAttempts: 3,
  retryBaseMs: 250,
  retryMaxMs: 4_000,
  endpointCooldownMs: 5_000,
  minIntervalMs: 250,
  requestTimeoutMs: 30_000,
});

const AUTH_MODES = new Set(["bearer", "x-api-key", "body"]);
const DEFAULT_SLEEP = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

function abortError() {
  return new TavilyClientError(499, "tavily-aborted", "Tavily search was cancelled");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function sleepAbortable(milliseconds, signal, sleepImpl) {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return;
  }
  throwIfAborted(signal);
  const sleeping = Promise.resolve().then(() => sleepImpl(milliseconds));
  if (!signal) {
    await sleeping;
    return;
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleeping, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
}

function boundedString(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  return headers[lower] ?? headers[name] ?? null;
}

function parseRetryAfter(headers, now) {
  const raw = headerValue(headers, "retry-after");
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function isPrivateLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const kind = isIP(host);
  if (kind === 4) {
    const fields = host.split(".").map(Number);
    const [first, second] = fields;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  if (kind === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  return false;
}

export class TavilyClientError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "TavilyClientError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = Number(options?.retryAfterMs ?? 0);
  }
}

export function validateEndpoint(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TavilyClientError(500, "tavily-endpoint-invalid", "Tavily endpoint configuration is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TavilyClientError(500, "tavily-endpoint-invalid", "Tavily endpoint configuration is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isPrivateLiteral(parsed.hostname)
  ) {
    throw new TavilyClientError(500, "tavily-endpoint-invalid", "Tavily endpoint configuration is invalid");
  }
  return parsed.toString();
}

export function parseEndpointList(value) {
  const entries = Array.isArray(value) ? value : String(value ?? "").split(",");
  const endpoints = entries.map((entry) => entry.trim()).filter(Boolean).map(validateEndpoint);
  if (endpoints.length === 0) {
    throw new TavilyClientError(503, "tavily-endpoint-not-configured", "Tavily search is not configured");
  }
  return [...new Set(endpoints)];
}

export function validateSearchRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TavilyClientError(400, "tavily-invalid-request", "Tavily search request is invalid");
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0 || query.length > TAVILY_LIMITS.maxQueryChars) {
    throw new TavilyClientError(400, "tavily-invalid-query", "Tavily search query is invalid");
  }
  const maxResults = input.max_results ?? TAVILY_LIMITS.defaultResults;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > TAVILY_LIMITS.maxResults) {
    throw new TavilyClientError(400, "tavily-invalid-results", "Tavily result count is invalid");
  }
  if (input.search_depth !== undefined && !["basic", "advanced"].includes(input.search_depth)) {
    throw new TavilyClientError(400, "tavily-invalid-depth", "Tavily search depth is invalid");
  }
  if (input.topic !== undefined && !["general", "news", "finance"].includes(input.topic)) {
    throw new TavilyClientError(400, "tavily-invalid-topic", "Tavily search topic is invalid");
  }
  return {
    query,
    max_results: maxResults,
    ...(input.search_depth === undefined ? {} : { search_depth: input.search_depth }),
    ...(input.topic === undefined ? {} : { topic: input.topic }),
  };
}

export function projectTavilyResponse(payload, fallbackQuery) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TavilyClientError(502, "tavily-invalid-response", "Tavily returned an invalid response");
  }
  const query = boundedString(payload.query, TAVILY_LIMITS.maxQueryChars) || fallbackQuery;
  const answer = boundedString(payload.answer, TAVILY_LIMITS.maxAnswerChars);
  const sourceResults = Array.isArray(payload.results) ? payload.results : [];
  const results = sourceResults.slice(0, TAVILY_LIMITS.maxResults).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const title = boundedString(item.title, TAVILY_LIMITS.maxTitleChars);
    const url = boundedString(item.url, TAVILY_LIMITS.maxUrlChars);
    const content = boundedString(item.content, TAVILY_LIMITS.maxContentChars);
    if (!title && !url && !content) return [];
    return [{
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(content ? { content } : {}),
      ...(Number.isFinite(item.score) ? { score: item.score } : {}),
      ...(boundedString(item.published_date, TAVILY_LIMITS.maxPublishedDateChars)
        ? { published_date: boundedString(item.published_date, TAVILY_LIMITS.maxPublishedDateChars) }
        : {}),
    }];
  });
  return {
    query,
    ...(answer ? { answer } : {}),
    results,
  };
}

function responseText(response) {
  if (response && typeof response.text === "function") return response.text();
  if (response && typeof response.json === "function") return response.json().then((value) => JSON.stringify(value));
  return Promise.reject(new TavilyClientError(502, "tavily-invalid-response", "Tavily returned an invalid response"));
}

export class TavilyClient {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    sleep = DEFAULT_SLEEP,
    random = Math.random,
    endpoints,
    authMode,
    authField,
    maxAttempts = TAVILY_LIMITS.maxAttempts,
    retryBaseMs = TAVILY_LIMITS.retryBaseMs,
    retryMaxMs = TAVILY_LIMITS.retryMaxMs,
    endpointCooldownMs = TAVILY_LIMITS.endpointCooldownMs,
    minIntervalMs = TAVILY_LIMITS.minIntervalMs,
    requestTimeoutMs = TAVILY_LIMITS.requestTimeoutMs,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TavilyClientError(500, "tavily-fetch-unavailable", "Tavily search is unavailable");
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.endpointOverride = endpoints;
    this.authModeOverride = authMode;
    this.authFieldOverride = authField;
    this.maxAttempts = Math.max(1, Math.min(5, maxAttempts));
    this.retryBaseMs = Math.max(1, retryBaseMs);
    this.retryMaxMs = Math.max(this.retryBaseMs, retryMaxMs);
    this.endpointCooldownMs = Math.max(0, endpointCooldownMs);
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.requestTimeoutMs = Math.max(1_000, requestTimeoutMs);
    this.endpointIndex = 0;
    this.cooldowns = new Map();
    this.nextAllowedAt = 0;
    this.rateQueue = Promise.resolve();
  }

  configuration() {
    const endpoints = this.endpointOverride ?? parseEndpointList(this.env.TAVILY_PROXY_URLS);
    const authMode = this.authModeOverride ?? String(this.env.TAVILY_PROXY_AUTH_MODE ?? "").trim().toLowerCase();
    if (!AUTH_MODES.has(authMode)) {
      throw new TavilyClientError(503, "tavily-auth-not-configured", "Tavily search is not configured");
    }
    const authField = this.authFieldOverride ?? String(this.env.TAVILY_PROXY_AUTH_FIELD ?? "").trim();
    if (authMode === "body" && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(authField)) {
      throw new TavilyClientError(503, "tavily-auth-field-not-configured", "Tavily search is not configured");
    }
    return { endpoints: parseEndpointList(endpoints), authMode, authField };
  }

  async waitForRate(signal) {
    const run = this.rateQueue.catch(() => {}).then(async () => {
      const delay = Math.max(0, this.nextAllowedAt - this.now());
      await sleepAbortable(delay, signal, this.sleep);
      this.nextAllowedAt = this.now() + this.minIntervalMs;
    });
    this.rateQueue = run.catch(() => {});
    await run;
  }

  chooseEndpoint(endpoints) {
    const now = this.now();
    const start = this.endpointIndex++ % endpoints.length;
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      const endpoint = endpoints[(start + offset) % endpoints.length];
      if ((this.cooldowns.get(endpoint) ?? 0) <= now) return endpoint;
    }
    return endpoints[start];
  }

  markEndpointFailure(endpoint) {
    if (this.endpointCooldownMs > 0) this.cooldowns.set(endpoint, this.now() + this.endpointCooldownMs);
  }

  async retryDelay(attempt, retryAfterMs, signal) {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
    const jitter = Math.floor(exponential * 0.25 * this.random());
    await sleepAbortable(Math.min(this.retryMaxMs, Math.max(retryAfterMs, exponential + jitter)), signal, this.sleep);
  }

  async request(input, configuration, signal) {
    const key = String(this.env.TAVILY_PROXY_API_KEY ?? "").trim();
    if (!key) throw new TavilyClientError(503, "tavily-not-configured", "Tavily search is not configured");
    const payload = { ...input };
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (configuration.authMode === "bearer") headers.authorization = `Bearer ${key}`;
    else if (configuration.authMode === "x-api-key") headers["x-api-key"] = key;
    else payload[configuration.authField] = key;

    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const endpoint = this.chooseEndpoint(configuration.endpoints);
    await this.waitForRate(signal);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal,
      cache: "no-store",
    });
    const status = Number(response?.status ?? 0);
    const retryAfterMs = parseRetryAfter(response?.headers, this.now());
    if (status >= 200 && status < 300) {
      let text;
      try {
        text = await responseText(response);
      } catch {
        throw new TavilyClientError(502, "tavily-invalid-response", "Tavily returned an invalid response");
      }
      if (Buffer.byteLength(String(text), "utf8") > TAVILY_LIMITS.maxResponseBytes) {
        throw new TavilyClientError(502, "tavily-response-too-large", "Tavily response is too large");
      }
      let parsed;
      try {
        parsed = JSON.parse(String(text));
      } catch {
        throw new TavilyClientError(502, "tavily-invalid-response", "Tavily returned an invalid response");
      }
      this.cooldowns.delete(endpoint);
      return projectTavilyResponse(parsed, input.query);
    }
    try { await response?.body?.cancel?.(); } catch {}
    if (status === 429) {
      this.markEndpointFailure(endpoint);
      throw new TavilyClientError(429, "tavily-rate-limited", "Tavily search is rate limited", { retryAfterMs });
    }
    if (status >= 500 || status === 0) {
      this.markEndpointFailure(endpoint);
      throw new TavilyClientError(502, "tavily-upstream", "Tavily search upstream is unavailable", { retryAfterMs });
    }
    if (status === 401 || status === 403) {
      throw new TavilyClientError(502, "tavily-auth-failed", "Tavily search authentication failed");
    }
    throw new TavilyClientError(502, "tavily-upstream-rejected", "Tavily search upstream rejected the request");
  }

  async search(input, { signal } = {}) {
    const request = validateSearchRequest(input);
    const configuration = this.configuration();
    let lastError = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await this.request(request, configuration, signal);
      } catch (error) {
        if (error instanceof TavilyClientError && [400, 499, 503].includes(error.status) && error.code !== "tavily-rate-limited") {
          throw error;
        }
        if (signal?.aborted) throw abortError();
        lastError = error instanceof TavilyClientError
          ? error
          : new TavilyClientError(502, "tavily-network", "Tavily search upstream is unavailable");
        if (attempt + 1 >= this.maxAttempts) break;
        await this.retryDelay(attempt, Number(error?.retryAfterMs ?? 0), signal);
      }
    }
    throw lastError ?? new TavilyClientError(502, "tavily-upstream", "Tavily search upstream is unavailable");
  }
}
