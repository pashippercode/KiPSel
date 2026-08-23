import assert from "node:assert/strict";
import test from "node:test";
import {
  TavilyClient,
  TavilyClientError,
  TAVILY_LIMITS,
  parseEndpointList,
  validateSearchRequest,
} from "./tavily.mjs";

const KEY = "test-only-tavily-sentinel";
const ENDPOINTS = [
  "https://search-one.example.test/search",
  "https://search-two.example.test/search",
];

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(overrides = {}) {
  return new TavilyClient({
    env: {
      TAVILY_PROXY_API_KEY: KEY,
      TAVILY_PROXY_URLS: ENDPOINTS.join(","),
      TAVILY_PROXY_AUTH_MODE: "bearer",
    },
    minIntervalMs: 0,
    sleep: async () => {},
    random: () => 0,
    ...overrides,
  });
}

test("endpoint and search validation reject unsafe or malformed configuration", () => {
  assert.deepEqual(parseEndpointList(ENDPOINTS.join(",")), ENDPOINTS);
  for (const value of [
    "http://search.example.test/search",
    "https://127.0.0.1/search",
    "https://192.168.1.10/search",
    "https://search.example.test/search?x=1",
    "https://user:pass@search.example.test/search",
  ]) {
    assert.throws(() => parseEndpointList(value), (error) => {
      assert.equal(error instanceof TavilyClientError, true);
      assert.equal(error.code, "tavily-endpoint-invalid");
      return true;
    });
  }
  assert.deepEqual(validateSearchRequest({ query: "  cats  ", max_results: 2 }), {
    query: "cats",
    max_results: 2,
  });
  assert.throws(() => validateSearchRequest({ query: "" }), /query is invalid/);
  assert.throws(
    () => validateSearchRequest({ query: "x", max_results: TAVILY_LIMITS.maxResults + 1 }),
    /result count is invalid/,
  );
});

test("missing key fails closed without invoking fetch", async () => {
  let calls = 0;
  const search = new TavilyClient({
    env: {
      TAVILY_PROXY_URLS: ENDPOINTS[0],
      TAVILY_PROXY_AUTH_MODE: "bearer",
    },
    fetchImpl: async () => {
      calls += 1;
      return response({ results: [] });
    },
    minIntervalMs: 0,
    sleep: async () => {},
  });
  await assert.rejects(search.search({ query: "cats" }), (error) => {
    assert.equal(error.code, "tavily-not-configured");
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("request uses the configured auth contract and projects bounded results", async () => {
  const calls = [];
  const search = client({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        query: "cats",
        answer: "A".repeat(TAVILY_LIMITS.maxAnswerChars + 100),
        results: [{
          title: "T".repeat(TAVILY_LIMITS.maxTitleChars + 100),
          url: "https://example.test/article",
          content: "C".repeat(TAVILY_LIMITS.maxContentChars + 100),
          score: 0.9,
          published_date: "2026-01-01",
          ignored: "not projected",
        }],
      });
    },
  });
  const result = await search.search({ query: "cats", max_results: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINTS[0]);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
  const requestBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(requestBody, { query: "cats", max_results: 1 });
  assert.equal(result.answer.length, TAVILY_LIMITS.maxAnswerChars);
  assert.equal(result.results[0].title.length, TAVILY_LIMITS.maxTitleChars);
  assert.equal(result.results[0].content.length, TAVILY_LIMITS.maxContentChars);
  assert.equal("ignored" in result.results[0], false);
});

test("body auth is selected only when explicitly configured", async () => {
  let requestBody;
  const search = client({
    authMode: "body",
    authField: "proxy_key",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response({ results: [] });
    },
  });
  await search.search({ query: "cats" });
  assert.deepEqual(requestBody, { query: "cats", max_results: 5, proxy_key: KEY });
});

test("429 and 5xx failures retry with endpoint rotation and safe errors", async () => {
  const calls = [];
  let attempt = 0;
  const search = client({
    fetchImpl: async (url) => {
      calls.push(url);
      attempt += 1;
      if (attempt === 1) return response({ error: "rate limited" }, 429, { "retry-after": "0" });
      if (attempt === 2) return response({ error: "temporary" }, 503);
      return response({ query: "cats", results: [{ title: "ok", url: "https://example.test", content: "done" }] });
    },
  });
  const result = await search.search({ query: "cats" });
  assert.equal(result.results[0].title, "ok");
  assert.deepEqual(calls, [ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[0]]);

  const failing = client({
    maxAttempts: 1,
    fetchImpl: async () => response({ error: KEY }, 503),
  });
  await assert.rejects(failing.search({ query: "cats" }), (error) => {
    assert.equal(error.code, "tavily-upstream");
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
});

test("response size is bounded before JSON parsing", async () => {
  const search = client({
    fetchImpl: async () => new Response("x".repeat(TAVILY_LIMITS.maxResponseBytes + 1), { status: 200 }),
  });
  await assert.rejects(search.search({ query: "cats" }), (error) => {
    assert.equal(error.code, "tavily-response-too-large");
    return true;
  });
});
