export const TAVILY_TOOL_LIMITS = Object.freeze({
  maxQueryChars: 1_000,
  maxResults: 10,
  maxOutputChars: 40_000,
});

export interface TavilyToolParams {
  query: string;
  search_depth?: "basic" | "advanced";
  topic?: "general" | "news" | "finance";
  max_results?: number;
}

export type TavilyToolParseResult =
  | { ok: true; value: TavilyToolParams }
  | { ok: false; code: string; message: string };

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

export function validateTavilyToolParams(input: unknown): TavilyToolParseResult {
  const candidate = objectValue(input);
  const query = typeof candidate.query === "string" ? candidate.query.trim() : "";
  if (query.length === 0 || query.length > TAVILY_TOOL_LIMITS.maxQueryChars) {
    return { ok: false, code: "invalid-query", message: "Search query is invalid" };
  }
  const maxResults = candidate.max_results ?? 5;
  if (
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > TAVILY_TOOL_LIMITS.maxResults
  ) {
    return { ok: false, code: "invalid-results", message: "Search result count is invalid" };
  }
  if (
    candidate.search_depth !== undefined &&
    candidate.search_depth !== "basic" &&
    candidate.search_depth !== "advanced"
  ) {
    return { ok: false, code: "invalid-depth", message: "Search depth is invalid" };
  }
  if (
    candidate.topic !== undefined &&
    candidate.topic !== "general" &&
    candidate.topic !== "news" &&
    candidate.topic !== "finance"
  ) {
    return { ok: false, code: "invalid-topic", message: "Search topic is invalid" };
  }
  return {
    ok: true,
    value: {
      query,
      max_results: maxResults,
      ...(candidate.search_depth === undefined
        ? {}
        : { search_depth: candidate.search_depth as TavilyToolParams["search_depth"] }),
      ...(candidate.topic === undefined
        ? {}
        : { topic: candidate.topic as TavilyToolParams["topic"] }),
    },
  };
}

export function formatTavilySearchResult(payload: unknown): string {
  const result = objectValue(payload);
  const query = textValue(result.query, TAVILY_TOOL_LIMITS.maxQueryChars) || "(unknown query)";
  const answer = textValue(result.answer, 8_000);
  const rawResults = Array.isArray(result.results) ? result.results : [];
  const sections: string[] = [`Search results for: ${query}`];
  if (answer) sections.push("\n[UNTRUSTED WEB SUMMARY]\n" + answer);

  rawResults.slice(0, TAVILY_TOOL_LIMITS.maxResults).forEach((item, index) => {
    const entry = objectValue(item);
    const title = textValue(entry.title, 512) || "Untitled result";
    const url = textValue(entry.url, 2_048);
    const content = textValue(entry.content, 8_000);
    const published = textValue(entry.published_date, 128);
    const score = typeof entry.score === "number" && Number.isFinite(entry.score)
      ? `\nScore: ${entry.score}`
      : "";
    sections.push(
      `\n[UNTRUSTED WEB RESULT ${index + 1}]\nTitle: ${title}` +
        (url ? `\nURL: ${url}` : "") +
        (published ? `\nPublished: ${published}` : "") +
        score +
        (content ? `\nSnippet: ${content}` : ""),
    );
  });

  const output = sections.join("\n");
  return output.length > TAVILY_TOOL_LIMITS.maxOutputChars
    ? `${output.slice(0, TAVILY_TOOL_LIMITS.maxOutputChars)}\n[Search output truncated]`
    : output;
}
