/**
 * claude-status-imitating — generic Pi extension (no tools, no commands).
 *
 * Replaces static "Working..." with Claude Code-style verbs that track the
 * current tool and name its target (file, regex, command). Safe to load next
 * to any other package; does not touch KiPSel QQ/controller monitoring.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ACTION_VERBS: readonly string[] = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Baking",
  "Brewing",
  "Calculating",
  "Cerebrating",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Computing",
  "Conjuring",
  "Considering",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Deliberating",
  "Determining",
  "Doing",
  "Effecting",
  "Finagling",
  "Forging",
  "Forming",
  "Generating",
  "Hatching",
  "Herding",
  "Honking",
  "Hustling",
  "Ideating",
  "Inferring",
  "Manifesting",
  "Marinating",
  "Moseying",
  "Mulling",
  "Mustering",
  "Musing",
  "Noodling",
  "Percolating",
  "Pondering",
  "Processing",
  "Puttering",
  "Reticulating",
  "Ruminating",
  "Schlepping",
  "Shucking",
  "Simmering",
  "Smooshing",
  "Spinning",
  "Stewing",
  "Synthesizing",
  "Thinking",
  "Transmuting",
  "Vibing",
  "Working",
];

export type ActivityKind =
  | "thinking"
  | "reading"
  | "searching"
  | "matching"
  | "writing"
  | "editing"
  | "executing"
  | "navigating"
  | "fetching"
  | "researching"
  | "delegating"
  | "validating"
  | "versioning"
  | "working";

export const ACTION_VERBS_BY_ACTIVITY: Record<ActivityKind, readonly string[]> = {
  thinking: [
    "Cerebrating",
    "Cogitating",
    "Considering",
    "Deliberating",
    "Ideating",
    "Inferring",
    "Marinating",
    "Mulling",
    "Musing",
    "Noodling",
    "Percolating",
    "Pondering",
    "Ruminating",
    "Simmering",
    "Stewing",
    "Thinking",
  ],
  reading: ["Appraising", "Inspecting", "Perusing", "Scanning", "Scrutinizing", "Studying", "Surveying"],
  searching: ["Foraging", "Hunting", "Prospecting", "Rummaging", "Scouring", "Sifting"],
  matching: [
    "Collating",
    "Discerning",
    "Discriminating",
    "Gleaning",
    "Matching",
    "Parsing",
    "Patterning",
    "Reticulating",
    "Sifting",
    "Winnowing",
  ],
  writing: ["Composing", "Crafting", "Forging", "Forming", "Generating", "Inscribing", "Manifesting", "Sculpting"],
  editing: ["Burnishing", "Emending", "Honing", "Refining", "Reworking", "Sculpting", "Transmuting"],
  executing: ["Actioning", "Actualizing", "Dispatching", "Effecting", "Hustling", "Invoking", "Orchestrating"],
  navigating: ["Cataloguing", "Cartographing", "Enumerating", "Surveying", "Traversing"],
  fetching: ["Harvesting", "Procuring", "Retrieving", "Summoning"],
  researching: ["Excavating", "Inquiring", "Investigating", "Prospecting"],
  delegating: ["Delegating", "Herding", "Mustering", "Orchestrating"],
  validating: ["Assaying", "Auditing", "Probing", "Validating", "Verifying"],
  versioning: ["Archiving", "Chronicling", "Versioning"],
  working: ACTION_VERBS,
};

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickFrom(palette: readonly string[], seed?: string | number): string {
  if (palette.length === 0) return ACTION_VERBS[0];
  if (seed === undefined) return palette[0];
  if (typeof seed === "number") {
    const n = Number.isFinite(seed) ? Math.floor(seed) : 0;
    return palette[Math.abs(n) % palette.length];
  }
  return palette[hashString(String(seed)) % palette.length];
}

function createPaletteRotator(palette: readonly string[], seed?: string | number): { next(): string } {
  const list = palette.length > 0 ? palette : ACTION_VERBS;
  let index = 0;
  if (seed !== undefined) {
    index =
      typeof seed === "number"
        ? Math.abs(Number.isFinite(seed) ? Math.floor(seed) : 0) % list.length
        : hashString(String(seed)) % list.length;
  }
  return {
    next() {
      const verb = list[index % list.length];
      index = (index + 1) % list.length;
      return verb;
    },
  };
}

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function basenamePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function shortenObject(value: string, max = 32): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function firstCommandToken(command: string): string {
  const withoutEnv = command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^(sudo|env|nice|nohup)$/.test(tokens[i] ?? "")) i++;
  const cmd = basenamePath(tokens[i] ?? tokens[0] ?? command);
  const next = tokens[i + 1];
  if (next && /^(npm|pnpm|yarn|bun|git|cargo|go|pip|poetry)$/.test(cmd) && !next.startsWith("-")) {
    return shortenObject(`${cmd} ${next}`, 24);
  }
  return shortenObject(cmd, 24);
}

function toolNameOf(event: Record<string, unknown>): string | undefined {
  if (typeof event.toolName === "string") return event.toolName;
  if (typeof event.tool_name === "string") return event.tool_name;
  return undefined;
}

function toolArgsOf(event: Record<string, unknown>): unknown {
  return event.args ?? event.input ?? event.parameters;
}

export function looksLikeRegex(pattern: string): boolean {
  return REGEX_METACHARS.test(pattern);
}

function inferFromBash(command: string): ActivityKind {
  const c = command;
  if (/\b(rg|grep|egrep|fgrep|ag|ack|pcregrep)\b/.test(c)) return "matching";
  if (/\bsed\b/.test(c) && /(^|\s)-[A-Za-z]*E\b/.test(c)) return "matching";
  if (/\b(awk|perl)\b/.test(c) && looksLikeRegex(c)) return "matching";
  if (/\bgit\b/.test(c)) return "versioning";
  if (
    /\b(pytest|vitest|jest|mocha|phpunit|cargo test|go test)\b/.test(c) ||
    /\b(npm|pnpm|yarn|bun)\s+test\b/.test(c) ||
    /\bnpm\s+run\s+test\b/.test(c)
  ) {
    return "validating";
  }
  if (/\b(curl|wget|httpie|aria2c)\b/.test(c)) return "fetching";
  if (/\b(ls|find|tree|fd|du)\b/.test(c)) return "navigating";
  if (/\b(cat|head|tail|less|more|bat|nl)\b/.test(c)) return "reading";
  return "executing";
}

function inferFromGrep(args: Record<string, unknown> | undefined): ActivityKind {
  if (args?.literal === true) return "searching";
  const pattern = stringField(args, "pattern", "regex", "query", "expression");
  if (pattern && looksLikeRegex(pattern)) return "matching";
  return "searching";
}

const TOOL_ACTIVITY: Record<string, ActivityKind> = {
  read: "reading",
  edit: "editing",
  write: "writing",
  ls: "navigating",
  find: "navigating",
  grep: "searching",
  bash: "executing",
  web_search: "researching",
  web_fetch: "fetching",
  fetch_content: "fetching",
  source_check: "reading",
  subagent: "delegating",
  llm_query: "thinking",
  workflow: "working",
  audit_workflow: "working",
  todo_write: "working",
};

export function inferActivityFromTool(toolName: string, args?: unknown): ActivityKind {
  const name = toolName.trim().toLowerCase();
  const record = asRecord(args);
  if (name === "grep") return inferFromGrep(record);
  if (name === "bash") {
    const command = stringField(record, "command", "cmd", "script");
    return command ? inferFromBash(command) : "executing";
  }
  if (name === "find") {
    const regex = stringField(record, "regex");
    if (regex && looksLikeRegex(regex)) return "matching";
    return "navigating";
  }
  return TOOL_ACTIVITY[name] ?? "working";
}

export function inferActivity(event: unknown): ActivityKind | undefined {
  const rec = asRecord(event);
  if (!rec) return undefined;
  const type = typeof rec.type === "string" ? rec.type : "";
  if (
    type === "before_provider_request" ||
    type === "turn_start" ||
    type === "agent_start" ||
    type === "before_agent_start" ||
    type === "session_start"
  ) {
    return "thinking";
  }
  const toolName = toolNameOf(rec);
  if (!toolName) return undefined;
  return inferActivityFromTool(toolName, toolArgsOf(rec));
}

export function objectFromTool(toolName: string, args?: unknown): string | undefined {
  const name = toolName.trim().toLowerCase();
  const rec = asRecord(args);
  if (name === "grep") {
    const pattern = stringField(rec, "pattern", "regex", "query", "expression");
    return pattern ? shortenObject(pattern, 28) : undefined;
  }
  if (name === "bash") {
    const command = stringField(rec, "command", "cmd", "script");
    return command ? firstCommandToken(command) : undefined;
  }
  if (name === "web_search") {
    const query = stringField(rec, "query", "q", "search");
    return query ? shortenObject(query, 28) : undefined;
  }
  if (name === "web_fetch" || name === "fetch_content") {
    const url = stringField(rec, "url", "href");
    if (!url) return undefined;
    try {
      return shortenObject(new URL(url).hostname, 28);
    } catch {
      return shortenObject(url, 28);
    }
  }
  if (name === "subagent") {
    const label = stringField(rec, "agent", "name") ?? stringField(rec, "task");
    return label ? shortenObject(label, 28) : undefined;
  }
  const path = stringField(rec, "path", "file_path", "file", "target", "filename");
  if (path) return shortenObject(basenamePath(path), 32);
  const glob = stringField(rec, "glob", "pattern", "name");
  return glob ? shortenObject(glob, 28) : undefined;
}

export interface ActivityHint {
  kind: ActivityKind;
  object?: string;
}

export function describeActivity(event: unknown): ActivityHint | undefined {
  const kind = inferActivity(event);
  if (!kind) return undefined;
  const rec = asRecord(event);
  const toolName = rec ? toolNameOf(rec) : undefined;
  const object = toolName ? objectFromTool(toolName, rec ? toolArgsOf(rec) : undefined) : undefined;
  return object ? { kind, object } : { kind };
}

export function formatWorkingMessage(verb: string, object?: string, suffix = "..."): string {
  return object ? `${verb} ${object}${suffix}` : `${verb}${suffix}`;
}

export function installWorkingActivityRotator(pi: ExtensionAPI): void {
  const suffix = "...";
  const intervalMs = 2500;
  let activeCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentKind: ActivityKind = "thinking";
  let currentObject: string | undefined;
  const activityRotators = new Map<ActivityKind, { next(): string }>();

  const rotatorFor = (kind: ActivityKind) => {
    let existing = activityRotators.get(kind);
    if (!existing) {
      existing = createPaletteRotator(ACTION_VERBS_BY_ACTIVITY[kind] ?? ACTION_VERBS);
      activityRotators.set(kind, existing);
    }
    return existing;
  };

  const nextMessage = (event?: unknown) => {
    const hint = event !== undefined ? describeActivity(event) : undefined;
    if (hint) {
      currentKind = hint.kind;
      currentObject = hint.object;
    }
    const verb =
      currentKind !== "working"
        ? rotatorFor(currentKind).next()
        : pickFrom(ACTION_VERBS, Math.floor(Math.random() * ACTION_VERBS.length));
    return formatWorkingMessage(verb, currentObject, suffix);
  };

  const updateMessage = (ctx?: ExtensionContext, event?: unknown) => {
    const targetCtx = ctx ?? activeCtx;
    if (typeof targetCtx?.ui?.setWorkingMessage === "function") {
      targetCtx.ui.setWorkingMessage(nextMessage(event));
    }
  };

  const startTimer = (ctx?: ExtensionContext) => {
    if (ctx) activeCtx = ctx;
    if (!timer) {
      timer = setInterval(() => updateMessage(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const onActivity = (event: unknown, ctx: ExtensionContext) => {
    activeCtx = ctx;
    updateMessage(ctx, event);
    startTimer(ctx);
  };

  const onIdle = (_event: unknown, ctx: ExtensionContext) => {
    stopTimer();
    currentObject = undefined;
    const targetCtx = ctx ?? activeCtx;
    if (typeof targetCtx?.ui?.setWorkingMessage === "function") {
      targetCtx.ui.setWorkingMessage(undefined);
    }
  };

  pi.on("session_start", onActivity);
  pi.on("before_agent_start", onActivity);
  pi.on("agent_start", onActivity);
  pi.on("turn_start", onActivity);
  pi.on("tool_execution_start", onActivity);
  pi.on("tool_call", onActivity);
  pi.on("before_provider_request", onActivity);
  pi.on("agent_end", onIdle);
  pi.on("agent_settled", onIdle);
  pi.on("session_shutdown", onIdle);
}

export default function claudeStatusImitating(pi: ExtensionAPI): void {
  installWorkingActivityRotator(pi);
}
