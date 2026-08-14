/**
 * Subagent Deliver — 子代理主动向主会话投递信息的工具
 *
 * 工作方式：
 *   - 主会话的 subagent 扩展在启动每个子代理进程时，通过环境变量
 *     PI_SUBAGENT_SPOOL / PI_SUBAGENT_AGENT 传入投递暂存目录与子代理名。
 *   - 本扩展在每个 pi 进程（含子代理进程）中注册 `deliver` 工具。
 *   - 子代理调用 deliver 时，本工具以原子写（tmp + rename）方式在暂存目录
 *     落一个 JSON 文件；主会话侧的轮询器读走文件后通过
 *     pi.sendMessage(..., { triggerTurn, deliverAs: "followUp" }) 投递进主会话。
 *   - 非子代理进程（未设置 PI_SUBAGENT_SPOOL）调用时返回说明文本，不写入任何文件。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_TITLE = 80;
const MAX_CONTENT = 4000;

interface DeliveryPayload {
	agent: string;
	title: string;
	content: string;
	urgent?: boolean;
	at: number;
}

function writeDeliveryFile(spoolDir: string, payload: DeliveryPayload): void {
	fs.mkdirSync(spoolDir, { recursive: true });
	const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	const tmpPath = path.join(spoolDir, `.tmp-${suffix}`);
	const finalPath = path.join(spoolDir, `d-${suffix}.json`);
	fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
	fs.renameSync(tmpPath, finalPath);
}

export default function subagentDeliverExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "deliver",
		label: "Deliver to main session",
		description:
			"Proactively push an important finding, blocker, or question to the orchestrator's main session while this subagent run is still in progress. Requires running inside a subagent (PI_SUBAGENT_SPOOL is set by the parent).",
		promptSnippet: "Deliver a message to the main session",
		promptGuidelines: [
			"Use deliver only for what the orchestrator must know EARLY: hard blockers, critical findings, or questions that block your task. Routine progress belongs in your final output.",
			"Keep it to at most a handful of calls per run; each delivery costs the main session a message.",
			"Be concise and evidence-based: prefer file:line references, exact command output, or a minimal repro.",
			"Set urgent:true only when the orchestrator must react right after the current turn (e.g. plan won't work, protected file in the way, dependency missing).",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: MAX_TITLE,
				description: "Short headline for the delivery, e.g. 'blocked: missing api key in auth.json'",
			}),
			content: Type.String({
				minLength: 1,
				maxLength: MAX_CONTENT,
				description: "The finding/message body with evidence. Concise; detailed context goes in your final output.",
			}),
			urgent: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						"true → main session is notified with a follow-up turn right after the current turn ends; false → message is shown and recorded without forcing a new turn.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const spoolDir = process.env.PI_SUBAGENT_SPOOL;
			if (!spoolDir) {
				return {
					content: [
						{
							type: "text",
							text: "deliver 只能在子代理运行中使用（主会话未设置 PI_SUBAGENT_SPOOL）。在子代理里调用会把消息投递到主会话。",
						},
					],
				};
			}
			const payload: DeliveryPayload = {
				agent: process.env.PI_SUBAGENT_AGENT ?? "unknown",
				title: params.title,
				content: params.content,
				urgent: params.urgent ?? false,
				at: Date.now(),
			};
			writeDeliveryFile(spoolDir, payload);
			return {
				content: [{ type: "text", text: `已投递到主会话：${payload.title}` }],
			};
		},
	});
}
