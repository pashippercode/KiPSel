/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const SUBAGENT_CONFIG_FILE = path.join(getAgentDir(), "subagent-config.json");

/**
 * 子代理主动投递（subagent-deliver 扩展）：
 * 子代理进程把投递消息作为 JSON 文件原子写入 spool 目录，
 * 主会话在子代理运行期间轮询该目录，并通过 deliver() 回调投递进主会话。
 */
interface DeliveryPayload {
	agent: string;
	title: string;
	content: string;
	urgent?: boolean;
	at?: number;
}

const DELIVERY_POLL_MS = 500;
const MAX_DELIVERIES_PER_RUN = 12;

async function withDeliverySpool<T>(
	deliver: (payload: DeliveryPayload) => void,
	fn: (spoolDir: string) => Promise<T>,
): Promise<T> {
	const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-deliver-"));
	const seen = new Set<string>();
	let delivered = 0;

	const drain = (): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(spoolDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json") || seen.has(entry.name)) continue;
			seen.add(entry.name);
			const filePath = path.join(spoolDir, entry.name);
			try {
				const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as DeliveryPayload;
				if (payload && typeof payload.title === "string" && typeof payload.content === "string") {
					if (delivered >= MAX_DELIVERIES_PER_RUN) {
						console.warn(`[subagent-delivery] dropped delivery (cap ${MAX_DELIVERIES_PER_RUN}): ${payload.title}`);
					} else {
						delivered++;
						deliver(payload);
					}
				}
			} catch (error) {
				console.warn(`[subagent-delivery] failed to parse delivery file: ${error}`);
			}
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* ignore */
			}
		}
	};

	const timer = setInterval(drain, DELIVERY_POLL_MS);
	try {
		return await fn(spoolDir);
	} finally {
		clearInterval(timer);
		drain();
		try {
			fs.rmSync(spoolDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * Session-scoped (in-memory) model overrides per agent name.
 * Never persisted; resets when the pi process restarts.
 */
const modelOverrides = new Map<string, string>();

/** Global default model for agents without an explicit `model:` in frontmatter. */
async function readDefaultModel(): Promise<string | undefined> {
	try {
		const raw = await fs.promises.readFile(SUBAGENT_CONFIG_FILE, "utf-8");
		const cfg = JSON.parse(raw) as { defaultModel?: string | null };
		return cfg.defaultModel || undefined;
	} catch {
		return undefined;
	}
}

async function writeDefaultModel(model: string | undefined): Promise<void> {
	const cfg = JSON.stringify({ defaultModel: model ?? null }, null, 2) + "\n";
	await fs.promises.writeFile(SUBAGENT_CONFIG_FILE, cfg, { encoding: "utf-8", mode: 0o600 });
}

/** Set or remove the `model:` line in an agent file's YAML frontmatter. */
export function setFrontmatterModel(filePath: string, model: string | undefined): boolean {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return false;
	}
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fmMatch) return false;
	const fm = fmMatch[1];
	const modelLine = /^model:\s*[^\n]*$/m;
	let newFm: string;
	if (model === undefined) {
		newFm = fm.replace(modelLine, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
	} else if (modelLine.test(fm)) {
		newFm = fm.replace(modelLine, `model: ${model}`);
	} else {
		const withModel = fm.replace(/^description:.*$/m, (m) => `${m}\nmodel: ${model}`);
		newFm = withModel === fm ? `${fm.trimEnd()}\nmodel: ${model}\n` : withModel;
	}
	content = content.replace(fmMatch[0], `---\n${newFm}---`);
	try {
		fs.writeFileSync(filePath, content, "utf-8");
		return true;
	} catch {
		return false;
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	deliverySpool: string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const effectiveModel = modelOverrides.get(agentName) ?? agent.model ?? (await readDefaultModel());
	if (effectiveModel) args.push("--model", effectiveModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	optimizePrompt: Type.Optional(
		Type.Boolean({
			description:
				"Run each task through the prompt optimizer before delegation (uses promptOptimizerModel from subagent-config.json, or optimizerModel). Default: false.",
			default: false,
		}),
	),
	optimizerModel: Type.Optional(
		Type.String({
			description: "Optional provider/model for the prompt optimizer (overrides subagent-config.json promptOptimizerModel)",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// ── 子代理主动投递（配合 subagent-deliver 扩展） ────────────────────────
	// 子代理进程通过 PI_SUBAGENT_SPOOL 环境变量把投递消息写到 spool 目录，
	// withDeliverySpool 的轮询器读走后调用 deliver()，经 pi.sendMessage 投递进主会话。
	let deliveryEnabled = false;
	const pendingDeliveries: DeliveryPayload[] = [];

	const deliver = (payload: DeliveryPayload): void => {
		const agentTag = payload.agent ? `[subagent:${payload.agent}] ` : "[subagent] ";
		const text = `${agentTag}${payload.title}\n${payload.content}`;
		if (!deliveryEnabled) {
			if (pendingDeliveries.length < 32) pendingDeliveries.push(payload);
			return;
		}
		try {
			const urgent = payload.urgent === true;
			pi.sendMessage(
				{ customType: "subagent-delivery", content: text, display: true },
				urgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
			);
		} catch (error) {
			if (pendingDeliveries.length < 32) pendingDeliveries.push(payload);
			console.warn(`[subagent-delivery] send failed; queued for retry: ${error}`);
		}
	};

	const flushPendingDeliveries = (): void => {
		if (!deliveryEnabled || pendingDeliveries.length === 0) return;
		const queued = pendingDeliveries.splice(0, pendingDeliveries.length);
		for (const payload of queued) deliver(payload);
	};

	pi.on("session_start", () => {
		deliveryEnabled = true;
		flushPendingDeliveries();
	});
	pi.on("session_shutdown", () => {
		deliveryEnabled = false;
	});

	// ── 提示词优化器（独立可选模型） ───────────────────────────────────────
	const PROMPT_OPTIMIZER_SYSTEM = [
		"You are a prompt optimizer for coding subagents. Rewrite the INPUT into a crisp, self-contained task prompt.",
		"Rules:",
		"- Preserve intent, scope, and constraints exactly; never add new requirements or widen scope.",
		"- Remove ambiguity and filler; state concrete acceptance criteria when inferable.",
		"- Keep placeholder tokens (e.g. {previous}) verbatim.",
		"- Output ONLY the optimized prompt text, no preamble, no fences.",
	].join("\n");

	const loadPromptOptimizerModel = async (): Promise<string | undefined> => {
		try {
			const raw = await fs.promises.readFile(SUBAGENT_CONFIG_FILE, "utf-8");
			const cfg = JSON.parse(raw) as { promptOptimizerModel?: string | null };
			return cfg.promptOptimizerModel || undefined;
		} catch {
			return undefined;
		}
	};

	const resolveOptimizerModel = async (
		requested: string | undefined,
		ctx: ExtensionContext,
	): Promise<Model<any>> => {
		const needle = requested?.trim() || (await loadPromptOptimizerModel())?.trim();
		const available =
			ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		if (needle) {
			const exact = available.find((model) => `${model.provider}/${model.id}` === needle);
			if (exact) return exact;
			if (!needle.includes("/")) {
				const matches = available.filter((model) => model.id === needle);
				if (matches.length === 1) return matches[0];
				if (matches.length > 1) throw new Error(`Model id "${needle}" is ambiguous. Use provider/model.`);
			}
			throw new Error(`Model "${needle}" is not available in the current model scope.`);
		}
		if (!ctx.model) throw new Error("No active model and no promptOptimizerModel configured in subagent-config.json.");
		return ctx.model;
	};

	const optimizerReasoningOptions = (model: Model<any>): Record<string, unknown> => {
		if (!model.reasoning) return {};
		switch (model.api) {
			case "openai-completions":
			case "openai-responses":
			case "openai-codex-responses":
			case "azure-openai-responses":
				return { reasoningEffort: "low" };
			case "anthropic-messages":
				return { thinkingEnabled: true, effort: "low" };
			case "google-generative-ai":
			case "google-vertex":
				return { thinking: { enabled: true, level: "low" } };
			case "bedrock-converse-stream":
			case "pi-messages":
				return { reasoning: "low" };
			default:
				return {};
		}
	};

	const runPromptOptimizer = async (
		prompt: string,
		context: string | undefined,
		requestedModel: string | undefined,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		maxTokens?: number,
	): Promise<{ text: string; model: Model<any>; elapsedMs: number; outputTokens: number }> => {
		const model = await resolveOptimizerModel(requestedModel, ctx);
		const startedAt = Date.now();
		const userText = context ? `CONTEXT:\n${context}\n\nINPUT:\n${prompt}` : `INPUT:\n${prompt}`;
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: PROMPT_OPTIMIZER_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
			},
			{
				signal,
				maxTokens: Math.min(maxTokens ?? 8192, model.maxTokens),
				cacheRetention: "none",
				...optimizerReasoningOptions(model),
			},
		);
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("optimizer returned empty output");
		return { text, model, elapsedMs: Math.max(1, Date.now() - startedAt), outputTokens: response.usage.output };
	};

	pi.registerTool({
		name: "optimize_prompt",
		label: "Optimize Prompt",
		description:
			"Rewrite a task prompt into a crisp, self-contained prompt for a coding subagent, using an independently selectable model (default: promptOptimizerModel from subagent-config.json).",
		promptSnippet: "Optimize a task prompt with an independent model",
		promptGuidelines: [
			"Use optimize_prompt before delegating fuzzy or verbose requests to subagents, especially when tokens matter.",
			"Pass the raw request plus any needed context; the optimizer preserves intent and never widens scope.",
			"Use the model parameter to route to a cheap model; the config default applies otherwise.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: 100_000, description: "The raw prompt to optimize" }),
			context: Type.Optional(
				Type.String({ maxLength: 50_000, description: "Optional extra context (e.g. SPEC, repo info) for the optimizer" }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional exact provider/model; overrides promptOptimizerModel in subagent-config.json" }),
			),
			maxTokens: Type.Optional(
				Type.Integer({ minimum: 256, maximum: 32768, description: "Maximum response tokens for the optimizer (default 8192)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runPromptOptimizer(params.prompt, params.context, params.model, ctx, signal, params.maxTokens);
			const modelName = `${result.model.provider}/${result.model.id}`;
			const stats = `[optimize_prompt stats: model=${modelName} elapsed=${result.elapsedMs}ms output_tokens=${result.outputTokens}]`;
			return {
				content: [{ type: "text", text: `${result.text}\n\n${stats}` }],
				details: { model: modelName, elapsedMs: result.elapsedMs, usage: { output: result.outputTokens } },
			};
		},
		renderCall(args, theme) {
			const preview = args.prompt.length > 100 ? `${args.prompt.slice(0, 100)}…` : args.prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("optimize_prompt ")) +
					theme.fg("accent", args.model || "configured model") +
					`\n${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const content = result.content.find((part: { type: string }) => part.type === "text") as
				| { type: "text"; text: string }
				| undefined;
			const stats = result.details?.model ? `${result.details.model} · ↓${result.details.usage?.output ?? 0}` : "";
			return new Text(
				`${theme.fg("toolOutput", content?.text ?? "(no output)")}${stats ? `\n${theme.fg("dim", stats)}` : ""}`,
				0,
				0,
			);
		},
	});

	pi.registerCommand("subagent-model", {
		description: "交互式设置子代理模型（单个 agent 或全局默认）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("仅 TUI 模式可用", "warning");
				return;
			}
			const discovery = discoverAgents(ctx.cwd, "user");
			const userAgents = discovery.agents.filter((a) => a.source === "user");
			const defaultModel = await readDefaultModel();
			const effective = (a: AgentConfig) => a.model ?? defaultModel ?? "(pi 默认)";

			const agentOptions = [
				`(全局默认) 当前: ${defaultModel ?? "(未设置 → pi 默认)"}`,
				...userAgents.map((a) => `${a.name} — ${effective(a)} — ${a.description}`),
			];
			const agentChoice = await ctx.ui.select("选择要设置模型的子代理", agentOptions);
			if (!agentChoice) return;
			const isGlobal = agentChoice.startsWith("(全局默认)");
			const agent = isGlobal ? undefined : userAgents[agentOptions.indexOf(agentChoice) - 1];

			const current = isGlobal ? defaultModel : agent?.model;
			const models = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			const modelOptions = [
				"(不设置 → 用 pi 默认模型)",
				...models.map((m) => (m === current ? `● ${m}` : m)),
			];
			const modelChoice = await ctx.ui.select(`选择模型（当前: ${current ?? "未设置"}）`, modelOptions);
			if (!modelChoice) return;
			const model = modelChoice.startsWith("(不设置") ? undefined : modelChoice.replace(/^●\s*/, "");

			if (isGlobal) {
				await writeDefaultModel(model);
				ctx.ui.notify(`子代理全局默认模型 → ${model ?? "pi 默认"}`, "info");
			} else if (agent) {
				if (!setFrontmatterModel(agent.filePath, model)) {
					ctx.ui.notify(`写入 ${agent.filePath} 失败`, "error");
					return;
				}
				ctx.ui.notify(`${agent.name} 模型 → ${model ?? "全局/pi 默认"}`, "info");
			}
		},
	});

	pi.registerTool({
		name: "subagent_set_model",
		label: "Subagent Set Model",
		description: [
			"Temporarily override which model a named subagent runs with (process-scoped, in-memory only; the agent .md file is NOT modified; cleared on pi restart or /reload).",
			"Use when an agent's configured model is unavailable (e.g. 429 rate limit) and you need to route it to a fallback model.",
			"Actions: set (agent+model), clear (agent), list (no args).",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["set", "clear", "list"] as const),
			agent: Type.Optional(Type.String({ description: "Agent name (required for set/clear)" })),
			model: Type.Optional(Type.String({ description: "Model like lavenda/xxx (required for set)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			if (action === "list") {
				if (modelOverrides.size === 0) return { content: [{ type: "text", text: "No model overrides active." }], details: {} };
				const lines = Array.from(modelOverrides.entries()).map(([a, m]) => `${a} → ${m}`);
				return { content: [{ type: "text", text: "Active overrides:\n" + lines.join("\n") }], details: {} };
			}
			const agentName = (params.agent ?? "").trim();
			if (!agentName) return { content: [{ type: "text", text: "agent is required for set/clear." }], details: {} };
			if (action === "clear") {
				const had = modelOverrides.delete(agentName);
				return { content: [{ type: "text", text: had ? `Override cleared: ${agentName}` : `No override was set for ${agentName}.` }], details: {} };
			}
			// set
			const model = (params.model ?? "").trim();
			if (!model) return { content: [{ type: "text", text: "model is required for set." }], details: {} };
			const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			if (!available.includes(model)) {
				return { content: [{ type: "text", text: `Unknown model "${model}". Available: ${available.join(", ")}` }], details: {} };
			}
			modelOverrides.set(agentName, model);
			return { content: [{ type: "text", text: `Override set: ${agentName} → ${model} (process-scoped, cleared on restart/reload)` }], details: {} };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runBody = async (spoolDir: string) => {
			const maybeOptimize = async (task: string): Promise<string> => {
				if (!params.optimizePrompt) return task;
				try {
					const optimized = await runPromptOptimizer(task, undefined, params.optimizerModel, ctx, signal);
					return optimized.text;
				} catch (error) {
					console.warn(`[subagent] prompt optimization failed, using original task: ${error}`);
					return task;
				}
			};
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{ type: "text", text: truncateOutput(getFinalOutput(results[results.length - 1].messages)) || "(no output)" },
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const task = await maybeOptimize(params.task);
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					spoolDir,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(result.messages)) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		};

			return withDeliverySpool((payload) => deliver(payload), runBody);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
