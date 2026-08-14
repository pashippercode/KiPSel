/**
 * workflow-audit — 工作流行为审核扩展（三档可切换：auto | llm | ask）
 *
 * 职责（只做确定性门禁，不做任何模型调用）：
 *   1. 危险 bash 命令在任意模式下直接拦截（rm -rf/sudo/chmod 777/mkfs/dd/git reset --hard/git clean -f）。
 *   2. 受保护路径（auth.json / .git / content chart / play_controller.gd / .env）写改拦截。
 *   3. phase 白名单：plan/review/verify 阶段禁用 edit|write；active/capture 允许（capture 仅允许写 knowledge）。
 *   4. 模式差异：
 *      - auto：越权即 block，不打扰用户；
 *      - ask ：越权弹确认；同一 scope 记住 "always"；
 *      - llm ：最严格的 auto（越权即 block，并要求后续 orchestrator 的 reviewer 环节；本扩展不调模型）。
 *   5. 会话持久化：mode / phase / approvedScopes 经 pi.appendEntry("workflow-audit", ...)。
 *
 * 交互：/audit-mode         —— 打开三档选择
 *       /audit-phase <p>   —— 用户显式强制覆盖 phase（不视为自动审计证据）
 *       audit_set_phase tool —— 编排器编程式切换 phase；/work 模板自动同步 phase=plan
 *       子代理应保持只读；写操作由继承当前 phase 的父编排器负责。
 * 启动：--audit-mode ask|auto|llm 可选 CLI flag（默认 ask）
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type AuditMode = "auto" | "llm" | "ask";
type Phase = "plan" | "active" | "review" | "verify" | "capture";

const SESSION_KEY = "workflow-audit";
const PHASES: readonly Phase[] = ["plan", "active", "review", "verify", "capture"] as const;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const AGENT_DIR = getAgentDir();

/** phase → 允许的工具集合（白名单；不在白名单的工具将被门禁逻辑处理） */
const PHASE_TOOLS: Record<Phase, ReadonlySet<string>> = {
	plan: new Set(["read", "bash", "grep", "find", "ls", "subagent", "audit_set_phase", "subagent_set_model", "get_goal", "update_goal", "llm_query", "deliver", "optimize_prompt"]),
	active: new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "audit_set_phase", "subagent_set_model", "get_goal", "update_goal", "llm_query", "deliver", "optimize_prompt"]),
	review: new Set(["read", "bash", "grep", "find", "ls", "subagent", "audit_set_phase", "subagent_set_model", "get_goal", "update_goal", "llm_query", "deliver", "optimize_prompt"]),
	verify: new Set(["read", "bash", "grep", "find", "ls", "audit_set_phase", "subagent_set_model", "get_goal", "update_goal", "llm_query", "deliver", "optimize_prompt"]),
	capture: new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "audit_set_phase", "subagent_set_model", "get_goal", "update_goal", "llm_query", "deliver", "optimize_prompt"]),
};

function normalizeAuditPath(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	if (/^file:\/\//i.test(normalized)) normalized = fileURLToPath(normalized);
	return normalized;
}

function canonicalPath(input: string, cwd: string): string {
	let pending = resolve(cwd, normalizeAuditPath(input));
	for (let depth = 0; depth < 40; depth++) {
		const root = parse(pending).root;
		const parts = pending.slice(root.length).split(sep).filter(Boolean);
		let cursor = root;
		let followedLink = false;

		for (let index = 0; index < parts.length; index++) {
			const candidate = join(cursor, parts[index]);
			let stat;
			try {
				stat = lstatSync(candidate);
			} catch {
				return resolve(cursor, ...parts.slice(index));
			}
			if (stat.isSymbolicLink()) {
				const target = readlinkSync(candidate);
				const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(candidate), target);
				pending = resolve(resolvedTarget, ...parts.slice(index + 1));
				followedLink = true;
				break;
			}
			cursor = candidate;
		}

		if (!followedLink) return realpathSync.native(pending);
	}
	throw new Error("Too many symbolic links");
}

function isEnvFile(path: string): boolean {
	const name = basename(path);
	return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function isProtected(inputPath: string, cwd: string): boolean {
	const candidates = [resolve(cwd, normalizeAuditPath(inputPath)), canonicalPath(inputPath, cwd)];
	return candidates.some((path) => {
		const segments = path.split("/").filter(Boolean);
		return (
			path === join(AGENT_DIR, "auth.json") ||
			segments.includes(".git") ||
			/\/content\/[^/]+\/chart\.txt$/.test(path) ||
			path.endsWith("/scripts/play/play_controller.gd") ||
			isEnvFile(path)
		);
	});
}

function isCapturePath(inputPath: string, cwd: string): boolean {
	const path = canonicalPath(inputPath, cwd);
	const knowledge = canonicalPath(join(AGENT_DIR, "knowledge"), cwd);
	return path === knowledge || path.startsWith(`${knowledge}/`);
}

function isDangerousCommand(input: unknown): boolean {
	if (typeof input !== "string") return false;
	const cmd = input;
	return (
		/\brm\b(?=[^;\n]*(?:\s-r\b|\s--recursive\b))(?=[^;\n]*(?:\s-f\b|\s--force\b))/i.test(cmd) ||
		/\brm\b.*\s-(?:[a-z]*r[a-z]*f[a-z]*|[a-z]*f[a-z]*r[a-z]*)\b/i.test(cmd) ||
		/\bsudo\b/i.test(cmd) ||
		/\b(chmod|chown)\b[^;|&]*777/i.test(cmd) ||
		/\bmkfs\b/i.test(cmd) ||
		/\bdd\b[^;|&]*\bof=\/dev\//i.test(cmd) ||
		/\bgit\s+reset\s+--hard\b/i.test(cmd) ||
		/\bgit\s+clean\b[^;|&]*-f/i.test(cmd)
	);
}

function isGitMutation(input: unknown): boolean {
	return (
		typeof input === "string" &&
		/\bgit\s+(?:add|am|apply|bisect|branch|checkout|cherry-pick|clean|commit|gc|merge|mv|notes|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|worktree)\b/i.test(input)
	);
}

const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"cmp",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"file",
	"grep",
	"head",
	"id",
	"jq",
	"ls",
	"md5sum",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sha256sum",
	"stat",
	"tail",
	"tree",
	"tr",
	"uname",
	"uniq",
	"wc",
	"whoami",
]);

// 用户批准的 git 变更放行白名单（2026-08-14，KiPSel 开源发布）：仅这两个项目根
// 目录下允许 git add/commit/push 等变更子命令；其余仓库维持拦截。.git 路径写保护不受影响。
const GIT_MUTATION_ALLOWED_ROOTS: readonly string[] = [
	"/home/xubuntu/Projects/KiPSel",
	"/home/xubuntu/Projects/astrbot_plugin_kipsel-public",
];

function isUnderGitAllowedRoot(canonical: string): boolean {
	return GIT_MUTATION_ALLOWED_ROOTS.some(
		(root) => canonical === root || canonical.startsWith(`${root}/`),
	);
}

/** 提取命令中显式的仓库选择器（-C / --git-dir / GIT_DIR=），用于防止借放行路径变更其他仓库。 */
function extractGitRepoOverrides(command: string): string[] {
	const overrides: string[] = [];
	const pattern = /(?:^|\s)(?:-C\s+(['"]?)([^\s'"]+)\1|--git-dir(?:=|\s+)(['"]?)([^\s'"]+)\3|GIT_DIR=(['"]?)([^\s'"]+)\5)/g;
	for (const match of command.matchAll(pattern)) {
		overrides.push(match[2] ?? match[4] ?? match[6]);
	}
	return overrides;
}

function isGitMutationAllowed(command: unknown, cwd: string): boolean {
	if (typeof command !== "string") return false;
	// 显式仓库选择器必须全部指向放行根内，不能仅靠 cwd 或路径子串获得权限。
	const overrides = extractGitRepoOverrides(command);
	if (overrides.length > 0) {
		return overrides.every((target) => {
			try {
				return isUnderGitAllowedRoot(canonicalPath(target, cwd));
			} catch {
				return false;
			}
		});
	}
	if (GIT_MUTATION_ALLOWED_ROOTS.some((root) => command.includes(root))) {
		return true;
	}
	try {
		return isUnderGitAllowedRoot(canonicalPath(cwd, cwd));
	} catch {
		return false;
	}
}

function isReadOnlyShellCommand(input: unknown): boolean {
	if (typeof input !== "string" || !input.trim()) return false;
	// This is intentionally not a shell parser: reject quoting/escaping plus expansion, redirection,
	// backgrounding, heredocs and multiline input. Complex commands require active+ask confirmation.
	if (/[<>&`$'"\\\r\n]/.test(input)) return false;
	const commands = input.split(/\|\||[;|]/).map((part) => part.trim()).filter(Boolean);
	if (commands.length === 0) return false;
	return commands.every((command) => {
		if (/^set\s+-[a-z]+$/i.test(command)) return true;
		if (/^command\s+-v\s+[\w+-]+$/i.test(command)) return true;
		const match = command.match(/^([\w+-]+)/);
		if (!match) return false;
		const executable = match[1];
		if (executable === "git") {
			return (
				/^git\s+(?:cat-file|describe|diff|log|ls-files|ls-tree|name-rev|rev-parse|show|status)(?:\s|$)/i.test(command) &&
				!/\s(?:--output(?:=|\s)|--ext-diff\b|--textconv\b)/i.test(command)
			);
		}
		if (executable === "find") {
			return !/\s-(?:delete|exec|execdir|fls|fprint|fprintf|ok|okdir)(?:\s|$)/i.test(command);
		}
		if ((executable === "rg" || executable === "grep") && /\s--(?:pre|pre-glob)(?:[=\s]|$)/i.test(command)) return false;
		if (executable === "tree" && /\s(?:-[^\s]*o[^\s]*|--output(?:\s|=|$))/i.test(command)) return false;
		if (executable === "file" && /\s(?:-[^\s]*C[^\s]*|--compile)(?:\s|$)/i.test(command)) return false;
		if (executable === "date" && /\s(?:-[^\s]*s[^\s]*|--set)(?:\s|=|$)/i.test(command)) return false;
		return READ_ONLY_COMMANDS.has(executable);
	});
}

function mentionsProtectedPath(input: unknown): boolean {
	return (
		typeof input === "string" &&
		/(?:auth\.json|(?:^|[\s/'"`])\.git(?:[\s/'"`]|$)|(?:^|[\s/'"`])(?:\.env(?:\*|\.[^\s/'"`]*)?|[^\s/'"`]+\.env)(?=$|[\s/'"`])|content\/[^"]*\/chart\.txt|scripts\/play\/play_controller\.gd)/i.test(input)
	);
}

function scopeKey(tool: string, input: Record<string, unknown>): string {
	const path = typeof input.path === "string" ? (input.path as string) : "";
	const cmd = typeof input.command === "string" ? (input.command as string) : "";
	const agent = typeof input.agent === "string" ? (input.agent as string) : "";
	return `${tool}:${path || cmd || agent || "unknown"}`;
}

interface State {
	mode: AuditMode;
	phase: Phase;
	scopes: Record<string, "single" | "always">;
}

export default function workflowAudit(pi: ExtensionAPI): void {
	const state: State = { mode: "ask", phase: "plan", scopes: {} };
	let activeApprovedThisRun = false;
	let planAwaitingApproval = false;
	let flagMode: AuditMode | undefined;

	const persist = () => pi.appendEntry(SESSION_KEY, { mode: state.mode, phase: state.phase, scopes: state.scopes });
	const isPhase = (value: unknown): value is Phase => typeof value === "string" && (PHASES as readonly string[]).includes(value);
	const isMode = (value: unknown): value is AuditMode => value === "auto" || value === "llm" || value === "ask";

	function restore(ctx: ExtensionContext): void {
		state.mode = "ask";
		state.phase = "plan";
		state.scopes = {};
		activeApprovedThisRun = false;
		planAwaitingApproval = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_KEY) continue;
			const data = entry.data as Partial<State> | undefined;
			if (isMode(data?.mode)) state.mode = data.mode;
			if (isPhase(data?.phase)) state.phase = data.phase;
			if (data?.scopes && typeof data.scopes === "object" && !Array.isArray(data.scopes)) state.scopes = data.scopes;
		}
	}

	function canToolTransition(next: Phase): boolean {
		if (next === state.phase || next === "plan") return true;
		if (state.phase === "plan") return next === "active" && activeApprovedThisRun;
		if (state.phase === "active") return next === "review";
		if (state.phase === "review") return next === "active" || next === "verify";
		if (state.phase === "verify") return next === "active" || next === "capture";
		return false;
	}

	/** In non-TUI modes, ask degrades to auto so unattended clients cannot hang on approval UI. */
	function effectiveMode(ctx: ExtensionContext): AuditMode {
		return ctx.mode === "tui" ? state.mode : state.mode === "ask" ? "auto" : state.mode;
	}
	const status = (ctx: ExtensionContext) =>
		ctx.ui.setStatus("workflow-audit", ctx.ui.theme.fg("accent", `audit:${state.mode} phase:${state.phase}`));

	pi.registerFlag("audit-mode", { description: "Workflow audit mode (auto|llm|ask)", type: "string" });

	pi.on("session_start", async (_e, ctx) => {
		restore(ctx);
		const flag = pi.getFlag("audit-mode");
		flagMode = isMode(flag) ? flag : undefined;
		if (flagMode) state.mode = flagMode;
		status(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		restore(ctx);
		if (flagMode) state.mode = flagMode;
		status(ctx);
	});

	pi.registerCommand("audit-mode", {
		description: "切换审核模式（auto / llm / ask）",
		handler: async (_args, ctx) => {
			const options = (["auto", "llm", "ask"] as const).map((m) => (m === state.mode ? `● ${m}` : m));
			const picked = await ctx.ui.select("Audit mode", options as unknown as string[]);
			if (!picked) return;
			state.mode = picked.replace(/^●\s*/, "") as AuditMode;
			persist();
			status(ctx);
			ctx.ui.notify(`audit mode → ${state.mode}`, "info");
		},
	});

	pi.registerCommand("audit-phase", {
		description: "用户强制覆盖工作流阶段（不作为自动审计证据）",
		handler: async (args, ctx) => {
			const p = args.trim() as Phase;
			if (!(PHASES as readonly string[]).includes(p)) {
				ctx.ui.notify(`无效阶段：${args}（可选：${PHASES.join("/")}）`, "error");
				return;
			}
			state.phase = p;
			persist();
			status(ctx);
			ctx.ui.notify(`phase → ${state.phase} (user override)`, "warning");
		},
	});

	pi.registerTool({
		name: "audit_set_phase",
		label: "Audit Set Phase",
		description: `Switch the workflow-audit phase. Valid phases: ${PHASES.join("/")}. The orchestrator calls this at workflow phase transitions (e.g. after user approves a plan → active).`,
		parameters: Type.Object({
			phase: Type.String({ description: `One of: ${PHASES.join(", ")}` }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = String(params.phase).trim() as Phase;
			if (!isPhase(p)) {
				return { content: [{ type: "text", text: `Invalid phase "${params.phase}". Valid: ${PHASES.join(", ")}` }], details: {} };
			}
			if (!canToolTransition(p)) {
				return {
					content: [{ type: "text", text: `Denied phase transition ${state.phase} → ${p}. plan → active requires an immediately preceding user approval; other transitions must follow the workflow.` }],
					details: {},
				};
			}
			state.phase = p;
			if (p === "active") {
				activeApprovedThisRun = false;
				planAwaitingApproval = false;
			}
			persist();
			status(ctx);
			return { content: [{ type: "text", text: `phase → ${state.phase}` }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
		activeApprovedThisRun =
			state.phase === "plan" &&
			planAwaitingApproval &&
			/^(?:y(?:es)?|ok(?:ay)?|proceed|approved?|sure|do it|go ahead|confirm(?:ed)?|是|好|同意|批准|可以|执行|开始|继续|继续吧|开干|开工|确认|搞吧|来吧)(?:[\s.!。！，,]|$)/i.test(prompt);
		planAwaitingApproval = false;
		if (prompt.startsWith("You are in WORKFLOW MODE")) {
			activeApprovedThisRun = false;
			if (state.phase !== "plan") {
				state.phase = "plan";
				persist();
				status(ctx);
			}
		}
	});

	pi.on("agent_settled", async () => {
		planAwaitingApproval = state.phase === "plan";
		activeApprovedThisRun = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		// 1) Shell gate. Directly dangerous/protected/git-mutating commands are always blocked.
		if (tool === "bash") {
			const command = input.command;
			const gitMutationBlocked = isGitMutation(command) && !isGitMutationAllowed(command, ctx.cwd);
			if (isDangerousCommand(command) || gitMutationBlocked || mentionsProtectedPath(command)) {
				return { block: true, reason: "workflow-audit: dangerous or protected-path shell command blocked" };
			}
			if (!isReadOnlyShellCommand(command)) {
				const mode = effectiveMode(ctx);
				if (state.phase !== "active") {
					return { block: true, reason: `workflow-audit: non-read-only shell command forbidden in phase=${state.phase} (mode=${mode}); use structured tools or active+ask approval` };
				}
				// active 相位 = 用户已批准执行（计划审批通过或 /audit-phase 显式切换），
				// 普通非只读命令不再逐条确认；危险命令/受保护路径/git 变更在上方硬拦截。
				if (mode === "auto" || mode === "llm") {
					return { block: true, reason: `workflow-audit: non-read-only shell command blocked in phase=active (mode=${mode}; no interactive approval channel)` };
				}
			}
		}

		// 2) Writes use the same file://, @, tilde and Unicode-space normalization as Pi's file tools.
		if ((tool === "edit" || tool === "write") && typeof input.path === "string") {
			try {
				if (isProtected(input.path, ctx.cwd)) {
					return { block: true, reason: `workflow-audit: protected path ${String(input.path)}` };
				}
				if (state.phase === "capture" && !isCapturePath(input.path, ctx.cwd)) {
					return { block: true, reason: `workflow-audit: capture phase only permits writes under ~/.pi/agent/knowledge (${String(input.path)})` };
				}
			} catch {
				return { block: true, reason: `workflow-audit: invalid or unresolvable path ${String(input.path)}` };
			}
		}

		// 3) phase 白名单
		if (!PHASE_TOOLS[state.phase].has(tool)) {
			const m = effectiveMode(ctx);
			if (m === "auto" || m === "llm") {
				return { block: true, reason: `workflow-audit: tool "${tool}" forbidden in phase=${state.phase} (mode=${m})` };
			}
			const ok = await ctx.ui.confirm("Audit approve?", `phase=${state.phase}\ntool=${tool}\nscope=${scopeKey(tool, input)}`);
			if (!ok) return { block: true, reason: "workflow-audit: denied by user (ask)" };
			return undefined;
		}

		// 4) ask 模式下，非 active 相位的高风险写改按 scope 记忆确认；active 相位视为已批准
		if (effectiveMode(ctx) === "ask" && state.phase !== "active" && (tool === "edit" || tool === "write" || tool === "subagent")) {
			const key = scopeKey(tool, input);
			if (state.scopes[key] !== "always") {
				const choice = await ctx.ui.select(`允许该操作？\n${key}`, ["仅本次", "本会话始终", "拒绝"]);
				if (choice !== "仅本次" && choice !== "本会话始终") {
					return { block: true, reason: "workflow-audit: denied by user (ask)" };
				}
				if (choice === "本会话始终") {
					state.scopes[key] = "always";
					persist();
				}
			}
		}

		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		const command = event.command;
		const protectedOrDangerous = isDangerousCommand(command) || isGitMutation(command) || mentionsProtectedPath(command);
		const nonReadOnly = !isReadOnlyShellCommand(command);
		let blocked = protectedOrDangerous || (state.phase !== "active" && nonReadOnly);
		if (!blocked && nonReadOnly) {
			const mode = effectiveMode(ctx);
			if (state.phase === "active") {
				// active = 已批准，不逐条确认（危险/受保护/git 已在上方硬拦）
			} else if (mode !== "ask") {
				blocked = true;
			} else {
				blocked = !(await ctx.ui.confirm("Audit user shell command?", command));
			}
		}
		if (!blocked) return;
		return {
			result: {
				output: `workflow-audit: shell command blocked in phase=${state.phase}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
