/**
 * Anchored Standard for pi (DSH-compat)
 * =====================================
 * Port of the dsh-anchored-standard two-phase bootstrap to pi CLI, plus a
 * default conversion layer for the common DSH tool contracts.
 *
 * What is converted (name + description + parameter schema + result text):
 *   read, write, edit, bash (POSIX), pwsh (Windows), todo_write
 *
 * Behavior:
 * - Every model request uses the fixed DSH persona:
 *   "You are a helpful software engineer assistant."
 * - Until the session records its first durable tool call, each provider
 *   request payload is filtered to exactly one shell tool plus `read`.
 * - After the first tool_call event, payloads are left untouched, so every
 *   later request in the same turn and in later turns exposes the full
 *   converted catalog.
 * - The promotion state is persisted as a custom session entry, so resuming a
 *   session keeps the full catalog (mirrors DSH deriving the phase from
 *   session events).
 *
 * Still different from DSH (pi-core limitations, not accidental):
 * - The wire protocol is pi's provider payload (OpenAI Responses/Completions,
 *   Anthropic, Google), not DSH's wire format.
 * - DSH result objects are structured schemas; pi tool results are
 *   text-content envelopes. We replicate DSH's model-visible text for the
 *   converted tools.
 * - Sandbox escalation and background jobs are not advertised because pi has
 *   no equivalent tool pair in this composition.
 *
 * Usage:
 *   pi -e ./anchored-standard.ts [prompt...]
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_PERSONA = "You are a helpful software engineer assistant.";
const DEFAULT_PROMOTE_AFTER_TURNS = 5;
const STATE_ENTRY_TYPE = "anchored-bootstrap";
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;
const READ_LIMIT = 2000;

interface AnchoredConfig {
  persona?: string;
  shellTools?: string[];
  commonTools?: string[];
  fullTools?: string[];
  /**
   * Expose the full catalog starting at this 1-based user turn.
   * "tool" or "first-tool-call" restores the DSH first-tool-call trigger.
   * Default: 5 (turns 1-4 stay minimal).
   */
  promoteAfterTurns?: number | "tool";
}

function parsePromoteSetting(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "tool" || value === "first-tool-call") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer or "tool"`);
  return n;
}

// ── tool schemas (DSH contract) ─────────────────────────────────────────────

const DSH_READ_PARAMS = Type.Object({
  file_path: Type.String({ description: "Path to read, resolved by the filesystem backend." }),
  offset: Type.Optional(Type.Number({ description: "1-based first line to return. Defaults to 1." })),
  limit: Type.Optional(Type.Number({ description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` })),
});

const DSH_WRITE_PARAMS = Type.Object({
  file_path: Type.String({ description: "Path to write, resolved by the filesystem backend." }),
  content: Type.String({ description: "Full UTF-8 text content to write." }),
});

const DSH_EDIT_PARAMS = Type.Object({
  file_path: Type.String({ description: "Path to edit, resolved by the filesystem backend." }),
  old_string: Type.String({ description: "Literal text to replace. Must match exactly." }),
  new_string: Type.String({ description: "Literal replacement text. Use an empty string to delete the match." }),
  replace_all: Type.Optional(
    Type.Boolean({ description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once." }),
  ),
});

const DSH_SHELL_COMMON_PARAMS = {
  command: Type.String({ description: "The command to execute." }),
  description: Type.String({
    description:
      "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). " +
      'Examples: "ls" -> "List files in current directory"; "git status" -> "Show working tree status"; "Get-Process" -> "List running processes".',
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.",
    }),
  ),
  workdir: Type.Optional(
    Type.String({
      description: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.",
    }),
  ),
};

const DSH_BASH_PARAMS = Type.Object({
  ...DSH_SHELL_COMMON_PARAMS,
  command: Type.String({ description: "The bash command to execute." }),
});

const DSH_PWSH_PARAMS = Type.Object({
  ...DSH_SHELL_COMMON_PARAMS,
  command: Type.String({ description: "The PowerShell command to execute." }),
});

const DSH_BASH_DESCRIPTION =
  "Execute a bash command and return its stdout/stderr. " +
  "Each call runs in a fresh bash process: no state (cwd, variables, functions) persists between calls — " +
  "pass `workdir` instead of using `cd`. " +
  "Non-zero exits are reported as `[exit code: N]`. " +
  "Current pi environment facts are exposed through managed `$PI_*` variables; inspect them when needed. " +
  "Long output is truncated to its tail.";

const DSH_PWSH_DESCRIPTION =
  "Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. " +
  "Each call runs in a fresh pwsh process: no state (cwd, variables, functions) persists between calls — " +
  "pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment " +
  "variables with `$env:NAME`. Non-zero exits are reported as `[exit code: N]`. " +
  "Current pi environment facts are exposed through managed `$env:PI_*` variables; inspect them when needed. " +
  "Long output is truncated to its tail.";

const DSH_TODO_PARAMS = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "What the task is — a short imperative line." }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
      ], { description: "pending (not started) | in_progress (now) | completed (done)." }),
    }),
    { description: "The COMPLETE task list, replacing any previous list." },
  ),
});

// ── helpers ─────────────────────────────────────────────────────────────────

function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  const t = tool as Record<string, unknown>;
  if (typeof t.name === "string") return t.name;
  const fn = t.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") return fn.name as string;
  return undefined;
}

function toolNamesInPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.tools)) return [];
  const names: string[] = [];
  for (const tool of p.tools) {
    const name = toolName(tool);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Extra tools passed through the bootstrap filter when present in the payload.
 *
 * Two groups:
 * - 投递/优化: deliver (subagent-deliver) 与 optimize_prompt (subagent) 是扩展注册
 *   的新工具，bootstrap 期间隐藏会破坏投递通道与提示词优化。
 * - 编排器工作流工具: work.md 引用的编排器工具（subagent、相位切换、目标锚点、
 *   llm_query）。anchored-standard 的 session_start 会重写全量目录，若不在此登记，
 *   主会话前 N 轮将拿不到这些工具，WORKFLOW MODE 的 Step 0 goal 锚定会直接失败。
 */
const BOOTSTRAP_PASSTHROUGH_TOOLS = [
  "deliver",
  "optimize_prompt",
  "subagent",
  "subagent_set_model",
  "audit_set_phase",
  "get_goal",
  "update_goal",
  "llm_query",
];

function filterPayloadTools(payload: unknown, shellTools: string[], commonTools: string[]): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.tools)) return payload;

  const available = toolNamesInPayload(payload);
  const availableShells = shellTools.filter((name) => available.includes(name));
  const missingCommon = commonTools.filter((name) => !available.includes(name));
  if (availableShells.length !== 1 || missingCommon.length > 0) {
    throw new Error(
      "anchored-standard: expected exactly one bootstrap shell and every common tool; " +
        `shells=${JSON.stringify(availableShells)}, missing=${JSON.stringify(missingCommon)}, ` +
        `available=${JSON.stringify(available)}`,
    );
  }

  const availablePassthrough = BOOTSTRAP_PASSTHROUGH_TOOLS.filter((name) => available.includes(name));
  const allowed = new Set([...availableShells, ...commonTools, ...availablePassthrough]);
  return {
    ...p,
    tools: p.tools.filter((tool) => {
      const name = toolName(tool);
      return name !== undefined && allowed.has(name);
    }),
  };
}

function restoreFromSession(ctx: { sessionManager: { getBranch(): unknown[] } }): { bootstrapped: boolean; turnCount: number } {
  const state = { bootstrapped: false, turnCount: 0 };
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.type === "custom" && e.customType === STATE_ENTRY_TYPE) {
        const data = e.data as { bootstrapped?: boolean; turnCount?: number } | undefined;
        if (data?.bootstrapped === true) state.bootstrapped = true;
        if (typeof data?.turnCount === "number" && data.turnCount > state.turnCount) state.turnCount = data.turnCount;
      }
    }
  } catch {
    // Session state is best-effort; fall through to fresh bootstrap.
  }
  return state;
}

function persistState(pi: ExtensionAPI, bootstrapped: boolean, turnCount: number): void {
  try {
    pi.appendEntry(STATE_ENTRY_TYPE, { bootstrapped, turnCount });
  } catch {
    // Persistence is best-effort; in-memory state still applies.
  }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line;
}

function lineByteSize(text: string, currentLineCount: number): number {
  return Buffer.byteLength(text, "utf8") + (currentLineCount > 0 ? 1 : 0);
}

interface ReadWindowResult {
  lines: Array<{ number: number; text: string }>;
  totalLines: number;
  truncatedByBytes: boolean;
}

function buildReadWindow(text: string, offset: number, limit: number): ReadWindowResult {
  const lines: Array<{ number: number; text: string }> = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;
  let lineBuffer = "";
  const cap = READ_MAX_LINE_LENGTH + 1;

  const flushLine = (): void => {
    const rawLine = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
    totalLines += 1;
    if (truncatedByBytes || totalLines < offset || lines.length >= limit) {
      lineBuffer = "";
      return;
    }
    const textLine = truncateLine(rawLine, READ_MAX_LINE_LENGTH);
    const bytes = lineByteSize(textLine, lines.length);
    if (outputBytes + bytes > READ_MAX_BYTES) {
      truncatedByBytes = true;
      lineBuffer = "";
      return;
    }
    outputBytes += bytes;
    lines.push({ number: totalLines, text: textLine });
    lineBuffer = "";
  };

  for (const chunk of [text]) {
    let startPos = 0;
    let newlinePos: number;
    while ((newlinePos = chunk.indexOf("\n", startPos)) !== -1) {
      lineBuffer += chunk.slice(startPos, newlinePos);
      flushLine();
      startPos = newlinePos + 1;
    }
    lineBuffer += chunk.slice(startPos);
  }
  if (lineBuffer.length > 0) flushLine();
  if (!truncatedByBytes && offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(`offset ${offset} is out of range (${totalLines} lines)`);
  }
  return { lines, totalLines, truncatedByBytes };
}

function formatReadOutput(displayPath: string, outcome: ReadWindowResult, offset: number): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, offset - 1);
  let footer: string;
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`;
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`;
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
    : footer;
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`;
}

function formatWriteOutput(displayPath: string, operation: "create" | "update"): string {
  const verb = operation === "create" ? "Created" : "Updated";
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${verb} file
</content>`;
}

function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`;
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return "[truncated]\n" + text.slice(text.length - maxChars);
}

// ── extension factory ───────────────────────────────────────────────────────

export default function anchoredStandard(pi: ExtensionAPI, config: AnchoredConfig = {}): void {
  const persona = config.persona ?? DEFAULT_PERSONA;
  const shellTools = config.shellTools ?? [process.platform === "win32" ? "pwsh" : "bash"];
  const commonTools = config.commonTools ?? ["read"];
  const fullTools = config.fullTools ?? [process.platform === "win32" ? "pwsh" : "bash", "read", "edit", "write", "todo_write"];
  let bootstrapped = false;
  let turnCount = 0;
  // Env/config are available at load time; the CLI flag is applied after
  // extension factories run, so it is resolved lazily on the first turn.
  let promoteAfterTurns = parsePromoteSetting(
    config.promoteAfterTurns ?? process.env.ANCHORED_PROMOTE_AFTER_TURNS ?? DEFAULT_PROMOTE_AFTER_TURNS,
    "promoteAfterTurns",
  );
  let promoteAfterTurnsResolved = false;

  pi.registerFlag("anchored-promote-after-turns", {
    type: "string",
    description: 'Expose the full catalog starting at this 1-based user turn (default: 5). Use "tool" to restore the DSH first-tool-call trigger.',
  });

  const effectivePromoteAfterTurns = (): number | undefined => {
    if (promoteAfterTurnsResolved) return promoteAfterTurns;
    promoteAfterTurnsResolved = true;
    const flagValue = pi.getFlag("anchored-promote-after-turns");
    if (flagValue !== undefined) {
      promoteAfterTurns = parsePromoteSetting(flagValue, "anchored-promote-after-turns");
    }
    return promoteAfterTurns;
  };

  const runShell = async (
    shell: string,
    args: string[],
    command: string,
    workdir: string | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    ctx: { cwd: string } | undefined,
  ): Promise<{ text: string; code: number; killed: boolean }> => {
    const cwd = workdir ?? ctx?.cwd ?? process.cwd();
    const result = await pi.exec(shell, args, { cwd, signal, timeout: timeoutMs });
    let text = result.stdout ?? "";
    if (result.stderr) text += text.length > 0 ? `\n${result.stderr}` : result.stderr;
    if (result.killed) {
      text += "\n[killed by signal]";
    } else {
      text += `\n[exit code: ${result.code}]`;
    }
    return { text: truncateTail(text, 8000), code: result.code, killed: result.killed };
  };

  // DSH-contract read override (shadows pi's built-in read).
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read a UTF-8 text file and return line-numbered content.",
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.",
    ],
    parameters: DSH_READ_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = params.file_path.trim();
      if (filePath.length === 0) throw new Error("file_path must be a non-empty string");
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath);
      const raw = await readFile(absolutePath, "utf8");
      const offset = params.offset === undefined ? 1 : params.offset;
      const limit = params.limit === undefined ? READ_LIMIT : params.limit;
      if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 1) {
        throw new Error("offset must be a positive integer");
      }
      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > READ_LIMIT) {
        throw new Error(`limit must be a positive integer less than or equal to ${READ_LIMIT}`);
      }
      const outcome = buildReadWindow(raw, offset, limit);
      return { content: [{ type: "text", text: formatReadOutput(absolutePath, outcome, offset) }] };
    },
  });

  // DSH-contract write override (shadows pi's built-in write).
  pi.registerTool({
    name: "write",
    label: "write",
    description: "Create or fully replace a UTF-8 text file.",
    promptSnippet: "Create or overwrite a file",
    promptGuidelines: [
      "Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first and prefer edit for targeted changes.",
    ],
    parameters: DSH_WRITE_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = params.file_path.trim();
      if (filePath.length === 0) throw new Error("file_path must be a non-empty string");
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath);
      let operation: "create" | "update" = "create";
      try {
        await readFile(absolutePath, "utf8");
        operation = "update";
      } catch {
        operation = "create";
      }
      await writeFile(absolutePath, params.content, "utf8");
      return { content: [{ type: "text", text: formatWriteOutput(absolutePath, operation) }] };
    },
  });

  // DSH-contract edit override (shadows pi's built-in edit).
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit an existing UTF-8 text file by replacing literal text.",
    promptSnippet: "Edit a file by literal text replacement",
    promptGuidelines: [
      "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first, unless you just created or edited it in this session.",
    ],
    parameters: DSH_EDIT_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = params.file_path.trim();
      if (filePath.length === 0) throw new Error("file_path must be a non-empty string");
      if (params.old_string.length === 0) throw new Error("old_string must be a non-empty string");
      if (params.old_string === params.new_string) throw new Error("old_string and new_string must differ");
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath);
      const original = await readFile(absolutePath, "utf8");
      const replaceAll = params.replace_all ?? false;
      const count = original.split(params.old_string).length - 1;
      if (count === 0) throw new Error("old_string not found in file");
      if (!replaceAll && count > 1) {
        throw new Error("old_string appears multiple times; set replace_all to true or provide a more specific old_string");
      }
      const updated = replaceAll ? original.split(params.old_string).join(params.new_string) : original.replace(params.old_string, params.new_string);
      await writeFile(absolutePath, updated, "utf8");
      return { content: [{ type: "text", text: formatEditOutput(absolutePath, replaceAll) }] };
    },
  });

  // Shell tool: pwsh on Windows, DSH-contract bash override on POSIX.
  if (process.platform === "win32") {
    if (shellTools.includes("pwsh")) {
      pi.registerTool({
        name: "pwsh",
        label: "pwsh",
        description: DSH_PWSH_DESCRIPTION,
        promptSnippet: "Execute PowerShell commands",
        parameters: DSH_PWSH_PARAMS,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const r = await runShell("pwsh", ["-NoProfile", "-Command", params.command], params.command, params.workdir, params.timeoutMs, signal, ctx);
          return { content: [{ type: "text", text: r.text }] };
        },
      });
    }
  } else if (shellTools.includes("bash")) {
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: DSH_BASH_DESCRIPTION,
      promptSnippet: "Execute bash commands",
      parameters: DSH_BASH_PARAMS,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const r = await runShell("bash", ["-c", params.command], params.command, params.workdir, params.timeoutMs, signal, ctx);
        return { content: [{ type: "text", text: r.text }] };
      },
    });
  }

  // DSH-contract todo_write (pi has no built-in todo_write).
  pi.registerTool({
    name: "todo_write",
    label: "todo_write",
    description:
      "Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list.",
    promptSnippet: "Track a structured task list",
    parameters: DSH_TODO_PARAMS,
    async execute(_toolCallId, params) {
      const todos = params.todos;
      return { content: [{ type: "text", text: JSON.stringify({ todos }, null, 2) }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const restored = restoreFromSession(ctx);
    bootstrapped = restored.bootstrapped;
    turnCount = restored.turnCount;
    // Own the full catalog, like a DSH preset composition does. The
    // BOOTSTRAP_PASSTHROUGH_TOOLS are always included when registered:
    // CLI --tools cannot select extension-registered tools (the registry is
    // not ready when the flag is resolved), so this is the single place that
    // guarantees deliver / optimize_prompt are active in both main and
    // subagent sessions.
    const catalog = [...fullTools, ...BOOTSTRAP_PASSTHROUGH_TOOLS];
    pi.setActiveTools(catalog.filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
  });

  pi.on("before_agent_start", () => {
    turnCount += 1;
    const promoteAfter = effectivePromoteAfterTurns();
    if (promoteAfter !== undefined && turnCount >= promoteAfter) {
      bootstrapped = true;
    }
    persistState(pi, bootstrapped, turnCount);
    return { systemPrompt: persona };
  });

  pi.on("tool_call", () => {
    if (effectivePromoteAfterTurns() !== undefined) return; // Turn-based mode: tool calls do not promote.
    if (bootstrapped) return;
    bootstrapped = true;
    persistState(pi, bootstrapped, turnCount);
  });

  pi.on("before_provider_request", (event) => {
    if (bootstrapped) return undefined;
    return filterPayloadTools(event.payload, shellTools, commonTools);
  });
}
