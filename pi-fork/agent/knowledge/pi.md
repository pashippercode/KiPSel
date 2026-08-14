# pi self-maintenance knowledge

## 2026-08-13: audit_set_phase + subagent_set_model tools

1. workflow-audit extension now registers an `audit_set_phase` LLM tool (orchestrator switches phase programmatically) plus a before_agent_start hook that auto-resets phase→plan when a prompt starts with "You are in WORKFLOW MODE" (the /work template marker). Both new tools are whitelisted in all 5 PHASE_TOOLS sets — any future custom orchestrator tool must be added to every set or it self-locks.
2. subagent extension now registers `subagent_set_model` (set/clear/list) — process-scoped in-memory per-agent model override, consulted before the agent .md frontmatter model. Use it when a subagent model 429s instead of editing the .md file. Cleared on restart/reload.
3. pi extension authoring: custom tools need TypeBox (`import { Type } from "typebox"`, StringEnum from pi-ai); AgentToolResult REQUIRES `details` (type error without it); verify with `node --experimental-strip-types --no-warnings --check`; end-to-end probe via `pi -p "call tool X..."`.
4. Agent .md frontmatter `model:` must exactly match a registry id — corrupted values with trailing "---" made planner/prompt-critic unregistered ("Unknown agent"). Fixed 2026-08-13 (both now lavenda/deepseek-v4-flash); .bak backups sit next to each modified file.
5. Available models as of 2026-08-13 include a new shuzhipic provider (gpt-5.6-sol/terra, deepseek-v4-flash-free, kimi-k3-free, glm-5.2-free, gemini-3.6-flash-high etc.) alongside lavenda.

## 2026-08-14: deliver 投递通道 + optimize_prompt + pi-fork（KiPSel）

1. 新增 `subagent-deliver` 扩展：子代理用 `deliver(title, content, urgent?)` 主动投递消息到主会话。链路：父 subagent 扩展给子进程注入 `PI_SUBAGENT_SPOOL`/`PI_SUBAGENT_AGENT` → 工具原子写 JSON 到 spool 目录 → 父侧 `withDeliverySpool` 500ms 轮询 → `pi.sendMessage({customType:"subagent-delivery"}, urgent ? {triggerTurn:true, deliverAs:"followUp"} : {triggerTurn:false})`。投递模式与 @quintinshaw/pi-dynamic-workflows 的 task-panel 生产实现一致（pending 队列 + session_start flush / session_shutdown suspend）。上限 12 条/运行。
2. 新增 `optimize_prompt` 工具（subagent 扩展内）：独立可选模型（`subagent-config.json` 的 `promptOptimizerModel`，默认 111/deepseek-v4-flash，每次调用可覆盖），输出带 stats 行；subagent 工具新增 `optimizePrompt`/`optimizerModel` 参数，三种模式下先优化再委托（失败回退原文，`{previous}` 占位符原样保留）。
3. **重要坑**：pi 的 `--tools` 在会话创建时解析，彼时扩展注册的工具（deliver/optimize_prompt）尚未进入 registry → 扩展工具永远无法通过 agent frontmatter `tools:` 传入子进程。修法：anchored-standard 的 `session_start` 全量目录加 `BOOTSTRAP_PASSTHROUGH_TOOLS=["deliver","optimize_prompt"]`，bootstrap 过滤器同样透传——这是目前唯一能保证主/子会话都能用扩展工具的挂点。以后新增"必须全会话可见"的扩展工具，都要在这里登记。
4. 验证手段：`pi --mode json -p --no-session --model <m> --tools ... "call tool X"` 直接端到端探针；扩展语法检查 `node --experimental-strip-types -e "import('...')"`（预期 ERR_MODULE_NOT_FOUND=语法通过）。
5. KiPSel pi-fork：定制层发行包在 `~/Projects/KiPSel/pi-fork/`（agent/ + install.sh + README），install.sh 策略：extensions/prompts/agents 总覆盖，knowledge/subagent-config/settings 仅缺失时写入，覆盖前备份到 `~/.pi/agent.backup.<ts>/`。**auth.json/models.json/sessions/pipilot 不入库**；提交前跑 `grep -rn -e "sk-[A-Za-z0-9]" agent/`。
6. npm 调研：`@quintinshow/pi-dynamic-workflows` 不存在；实际是 unscoped `pi-dynamic-workflows@1.0.1`（Michaelliv）+ `@quintinshaw/pi-dynamic-workflows@3.5.1`（QuintinShaw，pi≥0.80.8，journaled resume/workflow_control/per-agent 模型路由/后台投递）。
7. **goal → LLM 截断锚点（Codex 风格）**：productivity 扩展新增 `session_before_compact` 接管——active goal 存在时，用 `ctx.modelRegistry.getAuth(model)` 取鉴权，调用导出的 `compact(preparation, requestModel, apiKey, headers, goalInstructions, ...)` 生成带 goal 锚定指令的压缩摘要（保留 goal 相关事实/路径/决策，丢弃无关内容）；任何异常回退 pi 默认路径。`update_goal` 工具扩展为可编程 goal 自举（objective 参数，可创建/替换目标并重置计数）。work.md 已集成：Step 0 SPEC 定型后 `update_goal(objective=SPEC)`，Step 6 完成后 `status=complete`。
8. **anchored-standard 目录接管**：其 session_start 用 [bash,read,edit,write,todo_write] 重写全量工具目录 → 主会话前 N 轮会丢失所有扩展工具。BOOTSTRAP_PASSTHROUGH_TOOLS 现登记 deliver/optimize_prompt/subagent/subagent_set_model/audit_set_phase/get_goal/update_goal/llm_query（投递+编排器工作流工具集）。以后给 work.md 增加编排器工具时，必须同步登记这里，否则 Step 0 的 update_goal 等调用在前几轮会失败。

## 待优化 TODO（2026-08-14，KiPSel 发布流程踩坑）

- [x] 批准检测正则只认 `批准`+空白/`.`/`!`/`。`/`！`，不认全角逗号「，」→ 2026-08-15 已补：边界字符集加入 `，,`，批准词加入 sure/do it/go ahead/confirm/继续/继续吧/开干/开工/确认/搞吧/来吧。
- [ ] `isReadOnlyShellCommand` 对部分只读命令误判（如 `grep ... | head`、含特定字符串的 grep 模式曾被拦）→ 检查分词/管道判定。
- [x] auto/llm 模式下 active 阶段也全拦非只读 shell，且无 scoped 放行机制 → 2026-08-15 改为：**active 相位 = 用户已批准**，ask 模式下普通非只读命令与 edit/write/subagent 不再逐条确认（危险命令/受保护路径/git 变更仍硬拦截；auto/llm 无人工确认渠道，行为不变）。
- [ ] 子代理会话恒为 phase=plan 且非 TUI 下 ask→auto 降级，子代理因此无法执行任何非只读 bash → 考虑父编排器为子代理签发 scoped 授权或允许子代理继承父 phase。
