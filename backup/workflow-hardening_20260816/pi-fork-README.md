# KiPSel pi-fork

本机 pi 编码代理定制层的**发行仓库**。它不是 pi 源码的 fork，而是在官方 pi（目标版本 0.84.1）之上叠加的一整套工作流定制，以可安装、可回滚的发行包形式维护，属于 KiPSel 项目的一部分。

## 与官方 pi 的关系

```
官方 pi 0.84.x（@earendil-works/pi-*，不动）
  └─ KiPSel 定制层（本目录 agent/，安装到 ~/.pi/agent/）
       ├─ extensions/   工作流门控、子代理、计划模式、投递通道、提示词优化等
       ├─ prompts/      WORKFLOW MODE 及各步骤提示词（work.md 等）
       ├─ agents/       scout / planner / worker / reviewer / prompt-critic / capture-lesson
       ├─ knowledge/    会话经验库（pi / locatrix / generic / kipsel）
       └─ 根配置        AGENTS.md、APPEND_SYSTEM.md、keybindings.json、subagent-config.json、settings.json
```

> **旗舰特色**：workflow 模式（prompts/work.md + workflow-audit 五相位门控）是本定制层的核心——先勘察、再计划、批准后执行、审查、验证、沉淀。

## 定制层能力一览

| 扩展 | 作用 |
|---|---|
| `subagent/` | `subagent` 工具：单任务/并行/链式委托，每次调用独立 pi 进程冷启动；每任务记录 input/output/cacheRead/cost；`subagent_set_model` 会话级模型重路由；`optimize_prompt` 提示词优化环节（独立可选模型）+ `optimizePrompt` 委托集成；子代理投递管线 |
| `subagent-deliver/` | `deliver` 工具：子代理主动向主会话投递 blocker/发现/提问（spool 文件 → 主会话 `pi.sendMessage`，urgent 触发 follow-up 轮） |
| `workflow-audit/` | 五相位门控（plan/active/review/verify/capture）+ 只读命令白名单 + 受保护路径 + git 变更放行根；**active 相位 = 已批准**（ask 模式免逐条确认，危险/受保护/git 仍硬拦截） |
| `anchored-standard/` | DSH 风格 bootstrap：前 N 轮只暴露 shell+read 的省 token 工具裁剪；透传 deliver/optimize_prompt 及编排器工作流工具（subagent/audit_set_phase/update_goal 等） |
| `plan-mode/` | 只读计划模式：写工具禁用 + bash 白名单 + Plan: 步骤提取与进度跟踪 |
| `productivity/` | 会话目标 /goal、token 预算、`llm_query`、指标状态栏；**goal → LLM 截断锚点**：active goal 存在时接管 compaction，注入目标锚定指令（Codex 风格），`update_goal` 支持程序化 goal 自举 |
| `git-checkpoint.ts` | 每轮 git stash 检查点，供 /fork 恢复 |
| `locatrix-guard/` | locatrix 仓库专用守卫（chart.txt 等） |
| `model-manage/` | 模型配置管理命令 |
| `themes/kipfel.json` | Kipfel 橙棕主题：51 键完整主题（accent 橙 `#d9822b`、棕色边框、暖白文字），settings.json `"theme": "kipfel"` 启用 |
| `kipfel-ui/` | Kipfel 像素画启动 header（`setHeader`）+ Kipfel 风味 working message；全程 try/catch 防御：渲染异常回退为简版单行标题，注册失败则保留内置 header |

子代理模型：`111/gpt-5.6-luna`（各 agent frontmatter + `subagent-config.json` defaultModel）；提示词优化器模型：`subagent-config.json` 的 `promptOptimizerModel`（独立可选，每次调用可用 `model` 参数覆盖）。

## 安装 / 更新

```bash
./install.sh            # 增量安装：extensions/prompts/agents/AGENTS.md/APPEND_SYSTEM.md/keybindings.json 总是覆盖
                        # knowledge/、subagent-config.json、settings.json 仅在目标不存在时写入
./install.sh --force    # 覆盖全部文件
./install.sh --dry-run  # 只看将要执行的操作
```
> 注意：`settings.json` 与 `subagent-config.json` 是 if-missing 策略；已有安装需 `./install.sh --force` 才会应用本次主题/模型变更（--force 同时会覆盖 knowledge/，请先确认备份）。

安装后在 pi TUI 里执行 `/reload`。被覆盖的文件会先备份到 `~/.pi/agent.backup.<时间戳>/`，回滚即把备份拷回 `~/.pi/agent/`。

## 安全边界

- 本目录**不含** `auth.json`、`models.json`、`trust.json`、`sessions/`、`pipilot/`——密钥与运行时状态永不入库。
- `settings.json` 不含 API key；安装器默认不覆盖目标机已有的 settings.json。
- 提交前请运行：`grep -rn -e "sk-[A-Za-z0-9]" -e '"apiKey"' agent/` 应为空。

## 调研附录：@quintinshaw/pi-dynamic-workflows

2026-08-14 调研结论（供后续吸收参考）：

- npm 上 `@quintinshaw/pi-dynamic-workflows@3.5.1` 存在（pi ≥ 0.80.8 兼容，180 文件），是 Michaelliv `pi-dynamic-workflows@1.0.1` 的演进分支：journaled resume、`workflow_control` 工具、per-agent/per-phase 模型路由、后台运行 + 结果自动投递（`pi.sendMessage({customType}, {triggerTurn:true, deliverAs:"followUp"})`，含 pending 队列与 suspend/flush）、token/cost 计量、worktree 隔离。
- 本 fork 的 `deliver` 投递管线即采用其同一投递模式；`optimize_prompt` 对应其 prompt 优化思路，但落地为独立可选模型。
- 未整体采用原因：其子代理为进程内 in-memory 会话（与本机"冷启动独立进程 + 真实 usage 统计"路线不同），且与 workflow-audit 相位门控的交互需另行验证。

## 版本

- 定制层版本：0.2.0
- 目标 pi 版本：0.84.1
