# KiPSel 插件选型评估报告

> 调研日期：2026-08-19 · 调研方式：npm registry + tarball 流式审计（只读，未安装）
> 目标：为 KiPSel 现有缺陷（卡手/浪费/效率/功能泛用性）寻找可补充的 pi 插件

---

## 1. KiPSel 冲突基线（已从源码核实）

| 扩展 | 占用的钩子/资源 | 锚点 |
|---|---|---|
| productivity | `session_compact:748`、`session_before_compact:762`、`before_agent_start:808` | pi-fork/agent/extensions/productivity/index.ts |
| anchored-standard | `session_start:530`、`before_agent_start:544`、`tool_call:554`、`before_provider_request:561`；BOOTSTRAP_PASSTHROUGH_TOOLS 11 个 | pi-fork/agent/extensions/anchored-standard.ts:39 |
| workflow-audit | PHASE_TOOLS 五相位白名单（plan/review/verify 禁 edit/write） | pi-fork/agent/extensions/workflow-audit/index.ts:311 |
| plan-mode | `context/tool_call/before_agent_start/turn_end/agent_end/session_start` | pi-fork/agent/extensions/plan-mode/index.ts |
| KiPSel 哲学 | `--no-session` ephemeral，不落盘不持久化 | README.md:67 |

**冲突判定规则**：
- 🔴 高冲突：hook `session_before_compact`/`session_compact` 且做上下文注入（与 productivity 双 owner）
- 🟡 中冲突：hook compaction 但工具按需读写（无注入），或写持久化文件但可配置关闭
- 🟢 低/零冲突：不 hook compaction、不写持久化或只读、工具前缀不与现有 11 个 passthrough 重叠

---

## 2. 候选清单（14 个，按缺口分组）

### 缺口 1：会话外记忆 / 知识沉淀

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| pi-memory@0.4.2 | MIT | 11,180 | ✅ before_compact | `memory_*`,`scratchpad` | `~/.pi/agent/memory/*.md` | ≥0.81.1 | 中（qmd 可选） | 🔴 每轮注入 ~9KB 上下文 |
| pi-hermes-memory@0.9.6 | MIT | 5,627 | ✅ before_compact | `memory_*`,`session_search`,`skill_manage` | SQLite FTS5 | ≥0.80.1 | 中-**native better-sqlite3** | 🟡 policy-only 注入，较友好 |
| **pi-goosedump@0.12.53** | Apache-2.0 | 2,623 | ✅ before_compact | `goose_*` | goosedump CLI 存储 | ^0.82.1 | 中（外部 CLI） | 🟡 工具按需读写，无注入 |
| @remnic/plugin-pi@9.66.0 | MIT | 6,003 | ? | — | @remnic/core | * | 中 | ⚠️ 源码未审计 |

### 缺口 2：代码 diff 审查 / 变更摘要

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| **pi-simplify@0.2.3** | MIT | 3,331 | ❌ | `/simplify` 命令 | 无 | ≥0.74.0 | 极轻（零依赖） | 🟢 零冲突 |
| @plannotator/pi-extension@0.27.4 | — | 11,841 | — | 浏览器审阅 | `.pi/plannotator.json` | ≥0.79.1 | 重（web UI） | 🟡 写工程目录 |

### 缺口 3：token 用量 / 成本可观测

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| **pine-of-glass@0.10.1** | MIT | 663 | ❌ | context/trace/cache 面板 | 只读/内存 | * | 极轻（零依赖） | 🟢 零冲突 |
| @narumitw/pi-usage@0.52.0 | MIT | 3,368 | ❌ | `/usage`,`/fast` | 只读（5min 缓存） | * | 轻 | 🟢 零冲突 |
| @amaster.ai/pi-telemetry@0.1.9 | Apache-2.0 | 1,053 | ✅ session_compact | — | 远端 Langfuse/OTel | ≥0.79.1 | 中 | 🟡 需远端后端 |
| pi-tokenrouter@1.3.1 | MIT | 2,706 | ❌ | provider | `tokenrouter-models.json` | @mariozechner⚠️ | 轻 | 🔴 peerDeps 旧 scope |

### 缺口 4：Web 抓取 / 读 URL 正文（KiPSel 已有 tavily_search 但无 fetch）

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| **pi-web-access@0.24.0** | MIT | **64,357** | ❌ | `web_search`,`fetch_content`,`source_check` | `~/.pi/web-search.json` | * | 中-纯 JS | 🟢 零冲突，与 tavily 互补 |
| @juicesharp/rpiv-web-tools@2.6.2 | MIT | 2,398 | ❌ | `web_search`,`web_fetch` | 配置 | * | 轻 | 🟢 零冲突 |
| @ollama/pi-web-search@0.0.5 | MIT | 2,541 | ❌ | search/fetch | — | 无 | 极轻 | 🟢 零冲突 |

### 缺口 5：本地文档/代码库语义检索（轻量）

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| **@ff-labs/pi-fff@0.10.5** | MIT | 6,966 | ❌ | `fff`（覆盖 find/grep） | 只读 | * | 极轻 | 🟢 零冲突 |

### 缺口 6：通知 / 任务完成提醒

| 包@版本 | License | 周下载 | hook compaction | 新工具 | 持久化 | peerDeps pi | 重量 | 冲突 |
|---|---|---|---|---|---|---|---|---|
| pi-notify@1.4.0 | MIT | 69 | ❌ | —（事件） | 无 | * | 极轻 | 🟢 零冲突 |
| **@bacnh85/pi-notify@0.1.1** | MIT | 194 | ❌ | —（agent_settled/error） | 无 | 无 | 极轻（zero-dep） | 🟢 零冲突 |
| @2008muyu/pi-notify@1.1.2 | MIT | 31 | ❌ | — | 无 | * | 极轻（Bark 推送） | 🟢 零冲突（无头场景） |

---

## 3. 推荐引入 Top 3 + 备选

| 排名 | 包 | 覆盖缺口 | 理由 |
|---|---|---|---|
| 🥇 | **pi-web-access@0.24.0** | 缺口 4 | 直接补齐 KiPSel 缺失的 `fetch_content`/URL 正文阅读（readability→markdown + PDF + GitHub 克隆），周下载 64k 碾压级，纯 JS 依赖，零配置，与 tavily_search 天然互补，不 hook compaction 零冲突 |
| 🥈 | **pi-simplify@0.2.3** | 缺口 2 | 零依赖、只加 `/simplify` 命令、不 hook 不持久化，对"变更摘要"场景价值直接，零冲突 |
| 🥉 | **pine-of-glass@0.10.1** | 缺口 3+7 | 零依赖纯内存面板，终端内看 context 占用/cache 事件/TTFT/TPS 延迟，正好服务"远程 QQ 驱动的可见 pi TUI"场景，零冲突 |
| 备选 | **pi-goosedump@0.12.53** | 缺口 1+5 | 若确需跨会话记忆：工具按需读写（无上下文注入），是记忆类中与 KiPSel 冲突最低的方案；代价是外部 goosedump CLI + peerDep ^0.82.1 |
| 备选 | **@bacnh85/pi-notify@0.1.1** | 缺口 6 | 零依赖跨平台桌面通知+声音，可见 TUI 场景下零冲突；无头场景改用 @2008muyu/pi-notify（Bark 推送） |

---

## 4. 受控引入方案

> ⚠️ 实际安装需用户批准后另起 workflow。以下为预备方案。

### 4.1 安装命令（pi packages 机制）

```bash
# Top 3（零冲突，可直接装）
pi install pi-web-access
pi install pi-simplify
pi install pine-of-glass

# 备选（记忆类，需先验证 --no-session 兼容性）
pi install pi-goosedump

# 备选（通知类）
pi install @bacnh85/pi-notify
```

### 4.2 安装后验证步骤

1. `pi --version` 确认 pi 本体未受影响
2. 启动 ephemeral 会话（`pi --no-session`），确认无新持久化文件写入（除插件自身声明的配置文件）
3. 触发一次 compaction，确认 productivity 仍是唯一 compaction owner（无双 owner 冲突）
4. 检查 BOOTSTRAP_PASSTHROUGH_TOOLS 是否需要追加新工具名（pi-web-access 的 `web_search`/`fetch_content`/`source_check` 需要；pi-simplify/pine-of-glass/pi-notify 为命令/事件驱动，不需要）

### 4.3 预期需修改的 KiPSel 文件

| 文件 | 修改内容 | 原因 |
|---|---|---|
| pi-fork/agent/extensions/anchored-standard.ts:39 | BOOTSTRAP_PASSTHROUGH_TOOLS 追加 `"web_search","fetch_content","source_check"` | 让 pi-web-access 工具在 bootstrap 相位可用 |
| pi-fork/agent/extensions/workflow-audit/index.ts:311 | PHASE_TOOLS 各相位追加 `"web_search","fetch_content","source_check"` | 让 pi-web-access 工具在 plan/review/verify 相位可用 |

### 4.4 回滚方式

```bash
pi uninstall pi-web-access
pi uninstall pi-simplify
pi uninstall pine-of-glass
# 备选
pi uninstall pi-goosedump
pi uninstall @bacnh85/pi-notify
# 并回退 anchored-standard.ts / workflow-audit/index.ts 的工具白名单追加
```

---

## 5. 结论

- **立即可引入（零冲突）**：pi-web-access、pi-simplify、pine-of-glass、@bacnh85/pi-notify
- **需验证后引入（低冲突）**：pi-goosedump（先验证 `--no-session` 下 goosedump CLI 行为）
- **暂不建议引入**：pi-memory（上下文注入冲突）、pi-hermes-memory（native 依赖+注入）、pi-tokenrouter（peerDeps 旧 scope）、@plannotator/pi-extension（重 web UI）
- **已排除**：@cortexkit/pi-magic-context（详见 docs/magic-context-assessment.md，4 个直接冲突点）
