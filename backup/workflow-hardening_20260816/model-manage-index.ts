/**
 * Model Manage Extension
 *
 * Interactive TUI panel for managing model providers/channels in
 * ~/.pi/agent/models.json (modeled on ccswitch).
 *
 * Features:
 * - /model-manage opens a main menu: 新增渠道 / 编辑渠道 / 删除渠道 / 查看当前配置 / 退出
 * - Add: wizard (id, display name, baseUrl, api, apiKey, tree-style model editor)
 * - Edit: field sub-menu (baseUrl / apiKey / api / models tree / headers / authHeader),
 *   preserves unknown fields on save
 * - Delete: confirm with id + baseUrl, then unregister from the running session
 * - View: read-only provider list with masked apiKey + detail sheet
 *
 * Safety:
 * - Every write is preceded by fs.copyFileSync backup:
 *   models.json.bak-model-manage-<yyyymmdd-hhmmss> in the same directory
 * - Writes go through a temp file + fs.renameSync (atomic)
 * - apiKey literals are never echoed into notifications, list descriptions,
 *   confirm dialogs, or the LLM context (masked as $*** / ***len)
 */

import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SUPPORTED_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

type ApiType = (typeof SUPPORTED_APIS)[number];

const API_DESCRIPTIONS: Record<ApiType, string> = {
	"openai-completions": "OpenAI Chat Completions（兼容性最好）",
	"openai-responses": "OpenAI Responses API",
	"anthropic-messages": "Anthropic Messages API",
	"google-generative-ai": "Google Generative AI",
};

/** A model entry inside models.json; only `id` is required. */
interface ProviderModel {
	id: string;
	name?: string;
	api?: ApiType;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

/** A provider (channel) entry inside models.json. Unknown fields are preserved on save. */
interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: ApiType;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModel[];
	modelOverrides?: Record<string, unknown>;
	[key: string]: unknown;
}

interface ModelsFile {
	providers: Record<string, ProviderConfig>;
}

// ---------------------------------------------------------------------------
// File I/O (atomic write + backup)
// ---------------------------------------------------------------------------

function modelsFilePath(): string {
	return join(getAgentDir(), "models.json");
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Read models.json. Missing file -> empty. Parse failure -> throws (never writes over a broken file). */
function readModelsFile(): ModelsFile {
	const filePath = modelsFilePath();
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return { providers: {} };
		throw new Error(`读取 ${filePath} 失败：${e.message}`);
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ModelsFile>;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.providers !== "object" ||
			parsed.providers === null ||
			Array.isArray(parsed.providers)
		) {
			throw new Error("providers 字段缺失或格式错误");
		}
		return parsed as ModelsFile;
	} catch (err) {
		throw new Error(`解析 ${filePath} 失败：${(err as Error).message}`);
	}
}

/**
 * Write models.json atomically:
 * 1. backup via copyFileSync (aborts the write if backup fails)
 * 2. write temp file, then fs.renameSync over the target
 * Preserves the file's existing indentation style and permissions.
 */
function writeModelsFile(data: ModelsFile): void {
	const filePath = modelsFilePath();
	const dir = dirname(filePath);
	const stamp = timestamp();

	const backupPath = join(dir, `models.json.bak-model-manage-${stamp}`);
	try {
		fs.copyFileSync(filePath, backupPath);
	} catch (err) {
		throw new Error(`备份 models.json 失败：${(err as Error).message}`);
	}

	// Keep the existing indent (1 space / 2 spaces / tab / compact)
	let indent: string | number = 2;
	let mode = 0o600;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const m = raw.match(/\n(\s*)"[^"]+":/);
		if (m && m[1] !== undefined) indent = m[1].startsWith("\t") ? "\t" : m[1].length;
		mode = fs.statSync(filePath).mode & 0o777;
	} catch {
		// file missing -> defaults
	}

	const tmpPath = join(dir, `.models.json.tmp-${process.pid}-${stamp}`);
	try {
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, indent) + "\n", { encoding: "utf-8", mode });
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* ignore cleanup failure */
		}
		throw new Error(`写入 models.json 失败：${(err as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Masking / validation
// ---------------------------------------------------------------------------

/** Never show apiKey literals in the TUI: env refs -> $***, literals -> ***len. */
function maskApiKey(key: string | undefined): string {
	if (key === undefined || key === "") return "(未设置)";
	if (key.startsWith("$")) return "$***";
	if (key.startsWith("!")) return "!***";
	return `***${key.length}`;
}

function maskProviderEntry(entry: ProviderConfig): ProviderConfig {
	const copy: ProviderConfig = { ...entry };
	copy.apiKey = maskApiKey(copy.apiKey);
	return copy;
}

/** Strip // line comments (line-start) and /* *\/ block comments before JSON parsing. */
function stripJsonComments(text: string): string {
	const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
	return withoutBlocks.replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Resolve an apiKey reference only when it is needed at runtime. */
export function resolveApiKey(key: string | undefined): string | undefined {
	if (!key) return undefined;
	const envMatch = key.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/) ?? key.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (envMatch) return process.env[envMatch[1]] || undefined;
	if (key.startsWith("!")) {
		try {
			const output = execSync(key.slice(1), { encoding: "utf8" }).trim();
			return output || undefined;
		} catch {
			throw new Error("API Key 命令执行失败");
		}
	}
	return key;
}

interface UpstreamModel {
	id: string;
	[key: string]: unknown;
}

/** Map only model capabilities that pi understands from an upstream entry. */
export function normalizeUpstreamModel(entry: UpstreamModel): Partial<ProviderModel> {
	const normalized: Partial<ProviderModel> = {};
	const reasoning = [entry.reasoning, entry.supports_reasoning].find((value) => typeof value === "boolean");
	if (typeof reasoning === "boolean") normalized.reasoning = reasoning;

	const input = [entry.input_modalities, entry.modalities, entry.input_types].find(
		(value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
	);
	if (Array.isArray(input)) normalized.input = input as string[];

	const contextWindow = [entry.context_window, entry.contextWindow].find(
		(value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
	);
	if (typeof contextWindow === "number") normalized.contextWindow = contextWindow;

	const maxTokens = [entry.max_output_tokens, entry.maxTokens].find(
		(value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
	);
	if (typeof maxTokens === "number") normalized.maxTokens = maxTokens;

	const thinkingLevelMap = entry.thinkingLevelMap;
	if (typeof thinkingLevelMap === "object" && thinkingLevelMap !== null && !Array.isArray(thinkingLevelMap)) {
		normalized.thinkingLevelMap = thinkingLevelMap as Record<string, unknown>;
	}
	return normalized;
}

/** Return conservative defaults for an imported model id. */
export function modelDefaultsForId(id: string): Partial<ProviderModel> {
	const thinkingLevelMap: Record<string, unknown> = {
		off: "off",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
		ultra: "ultra",
	};
	return {
		reasoning: true,
		thinkingLevelMap,
		input: /image|vision|imagine|flash-image|draw|art/i.test(id) ? ["text", "image"] : ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Parse the common OpenAI-compatible model-list response shapes. */
export function parseUpstreamModelsResponse(payload: unknown): UpstreamModel[] {
	let entries: unknown;
	if (Array.isArray(payload)) entries = payload;
	else if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const response = payload as Record<string, unknown>;
		entries = Array.isArray(response.data) ? response.data : response.models;
	}
	if (!Array.isArray(entries)) throw new Error("响应中没有模型数组");

	const models: UpstreamModel[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const model = entry as Record<string, unknown>;
		if (typeof model.id !== "string" || !model.id) continue;
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model as UpstreamModel);
	}
	return models;
}

/** Format a model value for a one-line menu description without losing object/array structure. */
function formatModelValue(value: unknown, maxLength = 96): string {
	let text: string;
	if (typeof value === "string") {
		text = JSON.stringify(value);
	} else {
		try {
			const serialized = JSON.stringify(value);
			text = serialized === undefined ? String(value) : serialized;
		} catch {
			text = String(value);
		}
	}
	return truncateText(text, maxLength);
}

function jsonPrefill(value: unknown, fallback = "null"): string {
	if (value === undefined) return fallback;
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized === undefined ? fallback : serialized;
	} catch {
		return fallback;
	}
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	if (left === undefined || right === undefined) return left === right;
	return jsonPrefill(left) === jsonPrefill(right);
}

/** Set an arbitrary model property while preserving every other property unchanged. */
function setModelValue(model: ProviderModel, key: string, value: unknown): boolean {
	if (Object.prototype.hasOwnProperty.call(model, key) && jsonValuesEqual(model[key], value)) return false;
	model[key] = value;
	return true;
}

function formatContextWindow(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

/** Short summary shown beside a model id in the first tree level. */
function modelSummary(model: ProviderModel): string {
	const parts: string[] = [];
	if (Object.prototype.hasOwnProperty.call(model, "reasoning")) parts.push(`reasoning: ${String(model.reasoning)}`);
	if (Object.prototype.hasOwnProperty.call(model, "input")) {
		const input = Array.isArray(model.input) ? model.input.join(",") : formatModelValue(model.input);
		parts.push(`input: ${input}`);
	}
	if (model.api !== undefined) parts.push(`api: ${model.api}`);
	const context = formatContextWindow(model.contextWindow);
	if (context) parts.push(context);
	if (model.maxTokens !== undefined) parts.push(`maxTokens: ${formatModelValue(model.maxTokens)}`);
	if (typeof model.name === "string" && model.name.trim()) parts.push(`name: ${truncateText(model.name, 32)}`);
	const known = new Set(["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens"]);
	const extraKeys = Object.keys(model).filter((key) => !known.has(key));
	if (extraKeys.length > 0) parts.push(`其他: ${extraKeys.join(",")}`);
	return truncateText(parts.join(" · ") || "无额外属性", 140);
}

function parseJsonValueText(text: string): { value?: unknown; error?: string } {
	if (!text.trim()) return { error: "JSON 值不能为空" };
	try {
		return { value: JSON.parse(stripJsonComments(text)) };
	} catch (err) {
		return { error: `JSON 解析失败：${(err as Error).message}` };
	}
}

function parseInputArrayText(text: string): { input?: string[]; error?: string } {
	const parsed = parseJsonValueText(text);
	if (parsed.error) return { error: parsed.error };
	if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
		return { error: "input 必须是非空字符串数组，如 [ \"text\" ] 或 [ \"text\", \"image\" ]" };
	}
	if (parsed.value.some((item) => typeof item !== "string")) {
		return { error: "input 必须是非空字符串数组" };
	}
	return { input: parsed.value as string[] };
}

function parsePositiveIntegerText(text: string): { value?: number; error?: string } {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return { error: "必须是正整数" };
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value) || value <= 0) return { error: "必须是正整数" };
	return { value };
}

function parseHeadersText(text: string): { headers?: Record<string, string>; error?: string } {
	if (!text.trim()) return { headers: undefined };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { error: `JSON 解析失败：${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: '必须是 JSON 对象，如 { "x-custom": "value" }' };
	}
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v !== "string") return { error: `header "${k}" 的值必须是字符串` };
	}
	return { headers: parsed as Record<string, string> };
}

/** Returns an error message, or null when the provider config is valid. */
function validateProvider(id: string, cfg: ProviderConfig): string | null {
	if (!cfg.baseUrl) return "缺少 baseUrl";
	try {
		new URL(cfg.baseUrl);
	} catch {
		return `baseUrl 不是合法的 URL：${cfg.baseUrl}`;
	}
	if (cfg.api && !(SUPPORTED_APIS as readonly string[]).includes(cfg.api)) {
		return `不支持的 api：${cfg.api}（支持：${SUPPORTED_APIS.join(", ")}）`;
	}
	if (!cfg.models || cfg.models.length === 0) return "models 至少需要一个模型";
	for (const m of cfg.models) {
		if (!m.id || !m.id.trim()) return "模型缺少 id";
		if (m.api && !(SUPPORTED_APIS as readonly string[]).includes(m.api)) {
			return `模型 "${m.id}" 的 api 不支持：${m.api}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** SelectList dialog framed with DynamicBorder (see preset.ts / tui.md Pattern 1). */
async function showSelectList(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • Enter 选择 • Esc 取消")));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

type ModelValueEditor = "text" | "api" | "boolean" | "input" | "positiveInteger" | "json";

interface ModelsFlowResult {
	changed: boolean;
	cancelled: boolean;
}

interface ModelPropertiesFlowResult {
	changed: boolean;
}

function modelValueEditorForKey(key: string): ModelValueEditor {
	switch (key) {
		case "id":
		case "name":
			return "text";
		case "api":
			return "api";
		case "reasoning":
			return "boolean";
		case "input":
			return "input";
		case "contextWindow":
		case "maxTokens":
			return "positiveInteger";
		case "cost":
		case "thinkingLevelMap":
		case "compat":
		default:
			return "json";
	}
}

function modelValueEditorLabel(editor: ModelValueEditor): string {
	switch (editor) {
		case "text":
			return "文本";
		case "api":
			return "API 类型";
		case "boolean":
			return "布尔值";
		case "input":
			return "字符串数组";
		case "positiveInteger":
			return "正整数";
		case "json":
			return "JSON 值";
	}
}

/** Edit one model property and return whether a value was actually changed. */
async function editModelValue(
	ctx: ExtensionContext,
	model: ProviderModel,
	key: string,
	overrideEditor?: ModelValueEditor,
): Promise<boolean | null> {
	const editor = overrideEditor ?? modelValueEditorForKey(key);
	switch (editor) {
		case "text": {
			const current = model[key] === undefined ? "" : String(model[key]);
			const value = await ctx.ui.input(`属性 ${key}:`, current);
			if (value === undefined) return null;
			return setModelValue(model, key, value);
		}
		case "api": {
			const items: SelectItem[] = SUPPORTED_APIS.map((api) => ({
				value: api,
				label: api + (api === model[key] ? "（当前）" : ""),
				description: API_DESCRIPTIONS[api],
			}));
			const value = await showSelectList(ctx, `属性 ${key}（API 类型）`, items);
			if (value === null) return null;
			return setModelValue(model, key, value as ApiType);
		}
		case "boolean": {
			const value = await showSelectList(ctx, `属性 ${key}（布尔值）`, [
				{ value: "true", label: "true", description: "启用" },
				{ value: "false", label: "false", description: "禁用" },
			]);
			if (value === null) return null;
			return setModelValue(model, key, value === "true");
		}
		case "input": {
			let prefill = jsonPrefill(model[key], "[ \"text\" ]");
			while (true) {
				const text = await ctx.ui.editor(`属性 ${key}（JSON 字符串数组）:`, prefill);
				if (text === undefined) return null;
				const parsed = parseInputArrayText(text);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "error");
					prefill = text;
					continue;
				}
				return setModelValue(model, key, parsed.input);
			}
		}
		case "positiveInteger": {
			let prefill = model[key] === undefined ? "" : String(model[key]);
			while (true) {
				const text = await ctx.ui.input(`属性 ${key}（正整数）:`, prefill);
				if (text === undefined) return null;
				const parsed = parsePositiveIntegerText(text);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "error");
					prefill = text;
					continue;
				}
				return setModelValue(model, key, parsed.value);
			}
		}
		case "json": {
			let prefill = jsonPrefill(model[key]);
			while (true) {
				const text = await ctx.ui.editor(`属性 ${key}（JSON 值）:`, prefill);
				if (text === undefined) return null;
				const parsed = parseJsonValueText(text);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "error");
					prefill = text;
					continue;
				}
				return setModelValue(model, key, parsed.value);
			}
		}
	}
}

async function editModelId(ctx: ExtensionContext, models: ProviderModel[], model: ProviderModel): Promise<boolean | null> {
	let prefill = typeof model.id === "string" ? model.id : "";
	while (true) {
		const value = await ctx.ui.input("模型 id（必填，不能包含空白字符）:", prefill);
		if (value === undefined) return null;
		const id = value.trim();
		if (!id) {
			ctx.ui.notify("模型 id 不能为空", "error");
			prefill = value;
			continue;
		}
		if (/\s/.test(id)) {
			ctx.ui.notify("模型 id 不能包含空白字符", "error");
			prefill = id;
			continue;
		}
		if (models.some((candidate) => candidate !== model && candidate.id === id)) {
			ctx.ui.notify(`模型 id "${id}" 已存在`, "error");
			prefill = id;
			continue;
		}
		if (model.id === id) return false;
		model.id = id;
		return true;
	}
}

async function addModelToList(ctx: ExtensionContext, models: ProviderModel[]): Promise<boolean | null> {
	let prefill = "";
	while (true) {
		const value = await ctx.ui.input("新模型 id（必填，不能包含空白字符）:", prefill);
		if (value === undefined) return null;
		const id = value.trim();
		if (!id) {
			ctx.ui.notify("模型 id 不能为空", "error");
			prefill = value;
			continue;
		}
		if (/\s/.test(id)) {
			ctx.ui.notify("模型 id 不能包含空白字符", "error");
			prefill = id;
			continue;
		}
		if (models.some((model) => model.id === id)) {
			ctx.ui.notify(`模型 id "${id}" 已存在`, "error");
			prefill = id;
			continue;
		}
		models.push({ id });
		return true;
	}
}

function modelPropertyKeys(model: ProviderModel): string[] {
	return ["id", ...Object.keys(model).filter((key) => key !== "id")];
}

async function addModelProperty(ctx: ExtensionContext, model: ProviderModel): Promise<boolean | null> {
	let prefill = "";
	let key: string;
	while (true) {
		const value = await ctx.ui.input("新增属性名（不能为空）:", prefill);
		if (value === undefined) return null;
		key = value.trim();
		if (!key) {
			ctx.ui.notify("属性名不能为空", "error");
			prefill = value;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(model, key)) {
			ctx.ui.notify(`属性 "${key}" 已存在`, "error");
			prefill = key;
			continue;
		}
		break;
	}

	const suggested = modelValueEditorForKey(key);
	const typeItems: SelectItem[] = [];
	if (suggested !== "json") {
		typeItems.push({
			value: "typed",
			label: `${modelValueEditorLabel(suggested)}（按属性类型）`,
			description: `使用 ${key} 的专用校验`,
		});
	}
	typeItems.push({ value: "json", label: "JSON 值", description: "对象、数组或任意 JSON 标量" });
	const typeChoice = await showSelectList(ctx, `新增属性 "${key}"：选择值类型`, typeItems);
	if (typeChoice === null) return null;
	const changed = await editModelValue(ctx, model, key, typeChoice === "json" ? "json" : suggested);
	return changed === null ? null : changed;
}

async function deleteModelProperty(ctx: ExtensionContext, model: ProviderModel): Promise<boolean> {
	const keys = modelPropertyKeys(model);
	const choice = await showSelectList(
		ctx,
		`删除模型 "${model.id}" 的属性`,
		keys.map((key, index) => ({
			value: `property:${index}`,
			label: key,
			description: key === "id" ? "不可删除" : formatModelValue(model[key]),
		})),
	);
	if (choice === null) return false;
	const index = Number(choice.slice("property:".length));
	const key = keys[index];
	if (!key) return false;
	if (key === "id") {
		ctx.ui.notify("id 不可删除", "error");
		return false;
	}
	const ok = await ctx.ui.confirm("删除属性", `模型: ${model.id}\n属性: ${key}\n\n确认删除？`);
	if (!ok) return false;
	delete model[key];
	return true;
}

async function editModelProperties(
	ctx: ExtensionContext,
	models: ProviderModel[],
	modelIndex: number,
): Promise<ModelPropertiesFlowResult> {
	const model = models[modelIndex];
	if (!model) return { changed: false };
	let changed = false;

	while (true) {
		const propertyKeys = modelPropertyKeys(model);
		const items: SelectItem[] = propertyKeys.map((key, index) => ({
			value: `property:${index}`,
			label: key,
			description: formatModelValue(model[key]),
		}));
		items.push(
			{ value: "rename", label: "✏️ 重命名模型 id", description: `当前: ${model.id}` },
			{ value: "add-property", label: "＋ 新增属性", description: "添加任意名称和值类型的属性" },
			{ value: "delete-property", label: "🗑 删除属性", description: "选择属性后确认删除（id 不可删）" },
			{ value: "delete-model", label: "🗑 删除此模型", description: `删除模型 ${model.id}` },
			{ value: "back", label: "← 返回模型列表", description: "返回模型列表" },
		);
		const choice = await showSelectList(ctx, `模型 "${model.id}" 的属性`, items);
		if (choice === null || choice === "back") return { changed };

		if (choice === "rename") {
			const result = await editModelId(ctx, models, model);
			if (result) changed = true;
			continue;
		}
		if (choice === "add-property") {
			const result = await addModelProperty(ctx, model);
			if (result) changed = true;
			continue;
		}
		if (choice === "delete-property") {
			if (await deleteModelProperty(ctx, model)) changed = true;
			continue;
		}
		if (choice === "delete-model") {
			if (models.length <= 1) {
				ctx.ui.notify("至少需要保留一个模型", "error");
				continue;
			}
			const ok = await ctx.ui.confirm("删除模型", `模型: ${model.id}\n\n确认删除？`);
			if (!ok) continue;
			models.splice(modelIndex, 1);
			return { changed: true };
		}
		if (!choice.startsWith("property:")) continue;

		const propertyIndex = Number(choice.slice("property:".length));
		const key = propertyKeys[propertyIndex];
		if (!key) continue;
		const result = key === "id" ? await editModelId(ctx, models, model) : await editModelValue(ctx, model, key);
		if (result) changed = true;
	}
}

function redactApiKey(text: string, configuredKey: string | undefined, resolvedKey: string | undefined): string {
	let safe = text;
	for (const secret of [configuredKey, resolvedKey]) {
		if (secret) safe = safe.split(secret).join("[已隐藏]");
	}
	return safe;
}

/** Fetch upstream models and keep the selection UI open for repeated additions. */
async function fetchAndFillUpstreamModels(
	ctx: ExtensionContext,
	models: ProviderModel[],
	provider: ProviderConfig,
): Promise<boolean> {
	ctx.ui.notify("正在从上游获取模型列表…", "info");
	let status = "无";
	let responseText = "无";
	let resolvedKey: string | undefined;
	try {
		if (!provider.baseUrl) throw new Error("缺少 baseUrl");
		const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
		resolvedKey = resolveApiKey(provider.apiKey);
		const headers: Record<string, string> = {};
		if (resolvedKey && provider.authHeader !== false) headers.Authorization = `Bearer ${resolvedKey}`;
		Object.assign(headers, provider.headers ?? {});

		const response = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(15000),
		});
		status = String(response.status);
		responseText = await response.text();
		const safeText = redactApiKey(responseText, provider.apiKey, resolvedKey);
		if (!response.ok) {
			ctx.ui.notify(`从上游获取模型列表失败（状态码 ${status}）：响应：${truncateText(safeText, 512)}`, "error");
			return false;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(responseText);
		} catch {
			ctx.ui.notify(`从上游获取模型列表失败（状态码 ${status}）：响应 JSON 无法解析；响应：${truncateText(safeText, 512)}`, "error");
			return false;
		}
		let upstreamModels: UpstreamModel[];
		try {
			upstreamModels = parseUpstreamModelsResponse(payload);
		} catch {
			ctx.ui.notify(`从上游获取模型列表失败（状态码 ${status}）：响应格式无法识别；响应：${truncateText(safeText, 512)}`, "error");
			return false;
		}

		let changed = false;
		while (true) {
			const existingIds = new Set(models.map((model) => model.id));
			const items: SelectItem[] = upstreamModels.map((model, index) => {
				const extra = Object.fromEntries(Object.entries(model).filter(([key]) => key !== "id"));
				return {
					value: `upstream-model:${index}`,
					label: `${model.id}${existingIds.has(model.id) ? " ✓ 已存在" : ""}`,
					description: Object.keys(extra).length > 0 ? formatModelValue(extra, 96) : "无附加信息",
				};
			});
			items.push(
				{ value: "fill-all", label: "＋ 全部填入（跳过已存在）", description: "添加当前上游列表中的全部新模型" },
				{ value: "done", label: "← 完成", description: "返回模型列表" },
			);
			const choice = await showSelectList(ctx, `上游模型（${upstreamModels.length} 个）`, items);
			if (choice === null || choice === "done") return changed;
			if (choice === "fill-all") {
				let added = 0;
				let skipped = 0;
				for (const model of upstreamModels) {
					if (existingIds.has(model.id)) {
						skipped++;
						continue;
					}
					models.push({ id: model.id, ...modelDefaultsForId(model.id), ...normalizeUpstreamModel(model) });
					existingIds.add(model.id);
					added++;
				}
				if (added > 0) changed = true;
				ctx.ui.notify(`已填入 ${added} 个（跳过 ${skipped} 个已存在）`, "info");
				if (added > 0) ctx.ui.notify("已补全默认参数（思考深度/输入类型/上下文等），可在属性层修改", "info");
				return changed;
			}
			if (!choice.startsWith("upstream-model:")) continue;
			const index = Number(choice.slice("upstream-model:".length));
			const model = upstreamModels[index];
			if (!model) continue;
			if (existingIds.has(model.id)) {
				ctx.ui.notify(`已存在：${model.id}`, "info");
				continue;
			}
			models.push({ id: model.id, ...modelDefaultsForId(model.id), ...normalizeUpstreamModel(model) });
			changed = true;
			ctx.ui.notify(`已添加：${model.id}`, "info");
			ctx.ui.notify("已补全默认参数（思考深度/输入类型/上下文等），可在属性层修改", "info");
		}
	} catch {
		const safeText = redactApiKey(responseText, provider.apiKey, resolvedKey);
		ctx.ui.notify(`从上游获取模型列表失败（状态码 ${status}）：网络或请求错误；响应：${truncateText(safeText, 512)}`, "error");
		return false;
	}
}

/** Tree-style model editor: model list → property list → typed property value editor. */
async function editModelsFlow(
	ctx: ExtensionContext,
	models: ProviderModel[],
	provider: ProviderConfig,
): Promise<ModelsFlowResult> {
	let changed = false;
	while (true) {
		const items: SelectItem[] = models.map((model, index) => ({
			value: `model:${index}`,
			label: model.id,
			description: modelSummary(model),
		}));
		items.push(
			{ value: "add-model", label: "＋ 新增模型", description: "先输入模型 id，再逐项编辑属性" },
			{ value: "fetch-models", label: "⇣ 从上游获取模型", description: "从当前渠道的 /models 端点获取模型列表" },
			{ value: "done", label: "← 完成", description: "完成模型编辑并返回渠道" },
		);
		const choice = await showSelectList(ctx, `模型列表（${models.length} 个模型）`, items);
		if (choice === null) return { changed, cancelled: true };
		if (choice === "done") {
			if (models.length === 0) {
				ctx.ui.notify("至少需要一个模型", "error");
				continue;
			}
			return { changed, cancelled: false };
		}
		if (choice === "add-model") {
			const result = await addModelToList(ctx, models);
			if (result === null) return { changed, cancelled: true };
			if (result) changed = true;
			continue;
		}
		if (choice === "fetch-models") {
			if (await fetchAndFillUpstreamModels(ctx, models, provider)) changed = true;
			continue;
		}
		if (!choice.startsWith("model:")) continue;
		const modelIndex = Number(choice.slice("model:".length));
		if (!models[modelIndex]) continue;
		const result = await editModelProperties(ctx, models, modelIndex);
		if (result.changed) changed = true;
	}
}

/** Provider picker list: id (name) + baseUrl / masked apiKey / model count. */
async function pickProvider(
	ctx: ExtensionContext,
	title: string,
	providers: Record<string, ProviderConfig>,
): Promise<string | null> {
	const items: SelectItem[] = Object.entries(providers).map(([id, p]) => ({
		value: id,
		label: `${id}${p.name ? ` (${p.name})` : ""}`,
		description: `${p.baseUrl ?? "(无 baseUrl)"} · apiKey: ${maskApiKey(p.apiKey)} · ${p.models?.length ?? 0} 个模型`,
	}));
	return showSelectList(ctx, title, items);
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function showMainMenu(ctx: ExtensionContext): Promise<string | null> {
	return showSelectList(ctx, "模型渠道管理 (models.json)", [
		{ value: "add", label: "新增渠道", description: "向导式添加新 provider" },
		{ value: "edit", label: "编辑渠道", description: "修改 baseUrl / apiKey / api / models / headers / authHeader" },
		{ value: "delete", label: "删除渠道", description: "移除 provider 并从当前会话注销（先备份）" },
		{ value: "view", label: "查看当前配置", description: "只读浏览渠道与详情（apiKey 掩码）" },
		{ value: "exit", label: "退出", description: "关闭管理面板" },
	]);
}

/** Register the saved config in the current session so /model sees it immediately. */
function registerProviderInSession(pi: ExtensionAPI, id: string, config: ProviderConfig): void {
	// modelOverrides / oauth 等 models.json 特有字段不参与运行时注册；
	// ProviderConfig 仅接受以下字段（见 extensions.md pi.registerProvider）。
	pi.registerProvider(id, {
		name: config.name,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		api: config.api,
		headers: config.headers,
		authHeader: config.authHeader,
		models: config.models,
	} as Parameters<typeof pi.registerProvider>[1]);
}

/** 新增渠道: wizard with per-field validation; on failure re-prompts with the draft retained. */
async function addProviderFlow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const file = readModelsFile();
	let providerId = "";
	const draft: ProviderConfig = {};

	while (true) {
		// --- id ---
		while (true) {
			const v = await ctx.ui.input("渠道 ID（唯一标识，如 my-proxy）:", providerId);
			if (v === undefined) return;
			const trimmed = v.trim();
			if (!trimmed) {
				ctx.ui.notify("渠道 ID 不能为空", "error");
				continue;
			}
			if (/\s/.test(trimmed)) {
				ctx.ui.notify("渠道 ID 不能包含空白字符", "error");
				providerId = trimmed;
				continue;
			}
			if (file.providers[trimmed]) {
				ctx.ui.notify(`渠道 "${trimmed}" 已存在`, "error");
				providerId = trimmed;
				continue;
			}
			providerId = trimmed;
			break;
		}

		// --- display name ---
		const name = await ctx.ui.input("显示名称（可选，默认同 ID）:", draft.name ?? providerId);
		if (name === undefined) return;
		draft.name = name.trim() || providerId;

		// --- baseUrl ---
		let baseUrl: string | undefined;
		while (true) {
			const v = await ctx.ui.input("Base URL（API 端点）:", draft.baseUrl ?? "https://");
			if (v === undefined) return;
			const trimmed = v.trim();
			if (!trimmed) {
				ctx.ui.notify("baseUrl 不能为空", "error");
				continue;
			}
			try {
				new URL(trimmed);
			} catch {
				ctx.ui.notify(`baseUrl 不是合法的 URL：${trimmed}`, "error");
				continue;
			}
			baseUrl = trimmed;
			break;
		}
		draft.baseUrl = baseUrl;

		// --- api ---
		const apiItems: SelectItem[] = SUPPORTED_APIS.map((a) => ({
			value: a,
			label: a + (a === draft.api ? "（当前）" : ""),
			description: API_DESCRIPTIONS[a],
		}));
		const apiChoice = await showSelectList(ctx, "API 类型", apiItems);
		if (apiChoice === null) return;
		draft.api = apiChoice as ApiType;

		// --- apiKey ---
		const defaultKey = `$${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
		const apiKey = await ctx.ui.input(
			"API Key（支持 $ENV_VAR / ${ENV_VAR} / !command / 字面量，留空则稍后用 /login）:",
			draft.apiKey ?? defaultKey,
		);
		if (apiKey === undefined) return;
		draft.apiKey = apiKey.trim() || undefined;

		// --- models ---
		const models: ProviderModel[] = draft.models ?? [];
		const modelsResult = await editModelsFlow(ctx, models, draft);
		if (modelsResult.cancelled) return;
		draft.models = models;

		// --- combined validation (defense in depth; per-field checks above) ---
		const err = validateProvider(providerId, draft);
		if (err) {
			ctx.ui.notify(err, "error");
			continue;
		}

		// --- confirm before any write ---
		const preview = JSON.stringify(maskProviderEntry(draft), null, 2);
		const ok = await ctx.ui.confirm(
			"确认新增渠道",
			`将写入 ${modelsFilePath()}\n\n${preview}\n\n（写入前会自动备份 models.json）\n\n确认保存？`,
		);
		if (!ok) return;

		// --- save (re-check duplicate in case of concurrent writes) ---
		const fresh = readModelsFile();
		if (fresh.providers[providerId]) {
			ctx.ui.notify(`渠道 "${providerId}" 已被其他会话写入，请重试`, "error");
			continue;
		}
		fresh.providers[providerId] = draft;
		writeModelsFile(fresh);
		registerProviderInSession(pi, providerId, draft);
		ctx.ui.notify(`渠道 "${providerId}" 已保存，当前会话已生效`, "info");
		return;
	}
}

/** 编辑渠道: field sub-menu; on save rewrites the entry preserving unknown fields. */
async function editProviderFlow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const file = readModelsFile();
	const ids = Object.keys(file.providers);
	if (ids.length === 0) {
		ctx.ui.notify("没有可编辑的渠道", "warning");
		return;
	}

	const picked = await pickProvider(ctx, "选择要编辑的渠道", file.providers);
	if (!picked) return;

	const working: ProviderConfig = structuredClone(file.providers[picked]);
	let dirty = false;

	while (true) {
		const choice = await showSelectList(ctx, `编辑渠道 ${picked}`, [
			{ value: "baseUrl", label: `baseUrl: ${working.baseUrl ?? "(未设置)"}`, description: "API 端点地址" },
			{ value: "apiKey", label: `apiKey: ${maskApiKey(working.apiKey)}`, description: "API 密钥（$ENV / ${ENV} / !cmd / 字面量）" },
			{ value: "api", label: `api: ${working.api ?? "(未设置)"}`, description: "API 类型" },
			{ value: "models", label: `models: ${working.models?.length ?? 0} 个模型`, description: "模型列表" },
			{
				value: "headers",
				label: `headers: ${working.headers ? Object.keys(working.headers).join(",") : "(无)"}`,
				description: "自定义请求头",
			},
			{ value: "authHeader", label: `authHeader: ${String(working.authHeader ?? false)}`, description: "自动添加 Authorization: Bearer" },
			{ value: "save", label: "保存并退出", description: "写入 models.json 并注册到当前会话" },
			{ value: "cancel", label: "取消", description: "放弃修改" },
		]);
		if (!choice) {
			if (dirty) ctx.ui.notify(`渠道 "${picked}" 的修改未保存`, "info");
			return;
		}

		switch (choice) {
			case "baseUrl": {
				let prefill = working.baseUrl ?? "";
				while (true) {
					const v = await ctx.ui.input("baseUrl:", prefill);
					if (v === undefined) break;
					const trimmed = v.trim();
					if (!trimmed) {
						ctx.ui.notify("baseUrl 不能为空", "error");
						prefill = v;
						continue;
					}
					try {
						new URL(trimmed);
					} catch {
						ctx.ui.notify(`baseUrl 不是合法的 URL：${trimmed}`, "error");
						prefill = v;
						continue;
					}
					working.baseUrl = trimmed;
					dirty = true;
					break;
				}
				break;
			}
			case "apiKey": {
				const v = await ctx.ui.input("API Key（$ENV / ${ENV} / !cmd / 字面量，留空清除）:", working.apiKey ?? "");
				if (v === undefined) break;
				working.apiKey = v.trim() || undefined;
				dirty = true;
				break;
			}
			case "api": {
				const items: SelectItem[] = SUPPORTED_APIS.map((a) => ({
					value: a,
					label: a + (a === working.api ? "（当前）" : ""),
					description: API_DESCRIPTIONS[a],
				}));
				const v = await showSelectList(ctx, "API 类型", items);
				if (v === null) break;
				working.api = v as ApiType;
				dirty = true;
				break;
			}
			case "models": {
				const models = working.models ?? [];
				const result = await editModelsFlow(ctx, models, working);
				if (result.changed) {
					working.models = models;
					dirty = true;
				} else if (!result.cancelled) {
					working.models = models;
				}
				break;
			}
			case "headers": {
				let lastText: string | undefined;
				while (true) {
					const prefill = lastText ?? (working.headers ? JSON.stringify(working.headers, null, 2) : "");
					const text = await ctx.ui.editor("自定义请求头（JSON 对象，留空清除）:", prefill);
					if (text === undefined) {
						lastText = undefined;
						break;
					}
					const parsed = parseHeadersText(text);
					if (parsed.error) {
						ctx.ui.notify(parsed.error, "error");
						lastText = text;
						continue;
					}
					if (parsed.headers === undefined) delete working.headers;
					else working.headers = parsed.headers;
					dirty = true;
					lastText = undefined;
					break;
				}
				break;
			}
			case "authHeader": {
				const v = await showSelectList(ctx, "authHeader（自动添加 Authorization: Bearer）", [
					{ value: "true", label: "true", description: "自动添加 Authorization: Bearer <apiKey>" },
					{ value: "false", label: "false", description: "不自动添加" },
				]);
				if (v === null) break;
				working.authHeader = v === "true";
				dirty = true;
				break;
			}
			case "save": {
				const err = validateProvider(picked, working);
				if (err) {
					ctx.ui.notify(err, "error");
					break; // stay in sub-menu; working copy keeps the values
				}
				const fresh = readModelsFile();
				if (!fresh.providers[picked]) {
					ctx.ui.notify(`渠道 "${picked}" 已不存在（可能被其他会话修改）`, "error");
					return;
				}
				// Merge over the fresh entry so concurrently-added unknown fields survive
				fresh.providers[picked] = { ...fresh.providers[picked], ...working };
				writeModelsFile(fresh);
				registerProviderInSession(pi, picked, fresh.providers[picked]);
				ctx.ui.notify(`渠道 "${picked}" 已更新，当前会话已生效`, "info");
				return;
			}
			case "cancel":
				return;
		}
	}
}

/** 删除渠道: confirm with id + baseUrl, then delete and unregister. */
async function deleteProviderFlow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const file = readModelsFile();
	const ids = Object.keys(file.providers);
	if (ids.length === 0) {
		ctx.ui.notify("没有可删除的渠道", "warning");
		return;
	}

	const picked = await pickProvider(ctx, "选择要删除的渠道", file.providers);
	if (!picked) return;

	const entry = file.providers[picked];
	const ok = await ctx.ui.confirm(
		"删除渠道",
		`渠道: ${picked}\nbaseUrl: ${entry.baseUrl ?? "(未设置)"}\nmodels: ${entry.models?.length ?? 0} 个\n\n确认删除？写入前会自动备份 models.json。`,
	);
	if (!ok) return;

	const fresh = readModelsFile();
	if (!fresh.providers[picked]) {
		ctx.ui.notify(`渠道 "${picked}" 已不存在（可能被其他会话修改）`, "error");
		return;
	}
	delete fresh.providers[picked];
	writeModelsFile(fresh);
	pi.unregisterProvider(picked);
	ctx.ui.notify(`渠道 "${picked}" 已删除并从当前会话注销`, "info");
}

/** 查看当前配置: read-only list; selecting a provider shows a detail sheet with masked apiKey. */
async function viewProvidersFlow(ctx: ExtensionContext): Promise<void> {
	const file = readModelsFile();
	const ids = Object.keys(file.providers);
	if (ids.length === 0) {
		ctx.ui.notify("暂无渠道", "warning");
		return;
	}

	const picked = await pickProvider(ctx, "当前渠道（选择查看详情，Esc 返回）", file.providers);
	if (!picked) return;

	const detail = JSON.stringify(maskProviderEntry(file.providers[picked]), null, 2);
	await ctx.ui.editor(`渠道详情: ${picked}（只读，Esc 关闭）`, detail);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function modelManageExtension(pi: ExtensionAPI): void {
	pi.registerCommand("model-manage", {
		description: "管理模型渠道（models.json）：新增 / 编辑 / 删除 / 查看",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/model-manage 需要 TUI 模式", "error");
				return;
			}

			// Keep the panel open until the user picks 退出 or presses Esc
			let running = true;
			while (running) {
				try {
					const choice = await showMainMenu(ctx);
					switch (choice) {
						case "add":
							await addProviderFlow(pi, ctx);
							break;
						case "edit":
							await editProviderFlow(pi, ctx);
							break;
						case "delete":
							await deleteProviderFlow(pi, ctx);
							break;
						case "view":
							await viewProvidersFlow(ctx);
							break;
						default:
							running = false;
							break;
					}
				} catch (err) {
					ctx.ui.notify(`操作失败：${(err as Error).message}`, "error");
				}
			}
		},
	});
}
