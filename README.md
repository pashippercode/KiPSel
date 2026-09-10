# KiPSel

<p align="center">
  <img src="docs/assets/kipfel_main.jpg" alt="Kipfel - VRChat 3D Model" width="320" />
  <br>
  <em>项目名称取自 VRChat 虚拟形象 <strong>Kipfel</strong>（キプフェル / <a href="https://booth.pm/ja/items/5813187">もち山金魚</a>）🐾</em>
</p>

---

同一个 pi 编码会话，终端和浏览器各有一个完整前端；所有写操作都要走过五相位门控。

## 双前端

两个前端不是两套会话，而是**同一个 pi 进程**的两种呈现：

```
                    ┌─ TUI  ── grok-pi（Pi core + Grok Pager）—— 桌面前台
kipsel ──▶ pi 内核 ─┤
                    └─ web  ── PiPilot —— 手机 / 浏览器镜像同一会话
```

`kipsel` 启动 grok-pi。grok-pi 内部用 `pi --mode rpc` 驱动同一个 pi 内核，PiPilot relay 在这个 RPC 会话里把自己注册成一个 desktop source，于是手机端看到的会话、工具调用、审批弹窗，和终端里的是同一份状态，而不是另起一个会话去猜。

RPC 模式提供完整且 dialog-capable 的 ui 契约：`confirm` / `select` / `input` / `notify` / `setStatus` 都会转发给宿主。relay 因此能在 `rpc` 与 `tui` 两种形态下一致工作，包括把桌面上的审批弹窗转发到手机、失败时回落本地。

```bash
kipsel              # 启动 TUI；bridge 随之就绪，手机可接
kipsel --continue   # 继续上一个会话
kipselc             # 同上的快捷 shell 函数（定义在 ~/.bashrc.pi）
```

手机 / 浏览器一端要能连到本机 bridge：要么走 PiPilot 的 P2P 信令，要么与 9377 端口同处 Tailscale / 局域网。这部分配置在 `~/Projects/pi_pilot/bridge/config.json`。

## 工作流安全生产

写权限随相位收放，由 `workflow-audit` 扩展在工具层强制执行。日常长任务走 `/work`：它一进入就把相位强制拉回 `plan`，连续任务被切成五个相位。

普通会话默认停在 `active`，即直接可写；门控是从你启用 `/work` 那一刻开始生效的。

| 相位 | 允许的写操作 |
|---|---|
| `plan` | 只读（勘察 + 出计划） |
| `active` | **唯一**经过验证审查的写入发生在这里 |
| `review` | 只读（审 diff） |
| `verify` | 只读（跑最小验证，如实标注结果） |
| `capture` | 仅允许写 `knowledge/<scope>.md` |

- **plan → active 需要结构化授权**：adjacent 的用户批准 **加上** 当前 `planHash` / `revision` 匹配，才放行。一句口头"可以"不算授权。
- **llm 审查模式 fail-closed**：越权操作会送审查模型（`subagent-config.json` 的 `reviewModel`，`/audit-reviewer` 可切换），审查不可用时**拒绝**而不是放行。
- **危险操作与受保护路径硬拦截**，不受相位影响；git 变更只在放行根内允许。
- **只读命令白名单**：审查模式下 shell 也不是任意执行。

相位状态在状态栏可见，`workflow(action=phase_set)`（旧名 `audit_set_phase`）负责切换。

## 子代理

主代理不必独自干完所有活。`subagent` 把任务派给**上下文隔离**的子进程——子代理的探索、试错和中间日志都不会污染主会话的上下文窗口，只把结论带回来。

### 六个专职代理

| 代理 | 职责 | 写权限 |
|---|---|---|
| `scout` | 快速代码勘察，产出可交接的压缩上下文 | 无（只读） |
| `planner` | 从需求与上下文生成实施计划 | 无（只读） |
| `prompt-critic` | 把模糊任务改写成带验收标准的可执行规格 | 无（只读） |
| `worker` | 通用执行代理，完整能力 | 批准后写 |
| `reviewer` | 代码审查：质量与安全 | 无（只读 diff 审查） |
| `capture-lesson` | 把验证过的经验追加进 `knowledge/<scope>.md` | 受相位硬拦截限制 |

只读代理的 `tools` 里根本没有 `edit`/`write`，所以"只读"是能力层面的约束，不是靠提示词自觉。`capture-lesson` 是例外：它有写工具，但 `capture` 相位会硬拦截 `~/.pi/agent/knowledge` 之外的任何写入。

### 三种编排形态

```js
subagent({ agent: "scout", task: "..." })                    // 单发
subagent({ tasks: [{agent, task, scope}, ...] })             // 并行
subagent({ chain: [{agent, task}, {agent, task}] })          // 串行，后一步用 {previous}
```

**写冲突由 scope 调度器挡住**：并行任务若声明了重叠的 `scope` 根，会被自动串行化——并行度换不来竞态。确实不写盘的任务用 `readOnly: true` 显式声明，它们可以共享空 scope。

### 后台作业

`background: true` 让子代理脱离当前轮次运行，立即返回 job id，完成时以 follow-up 回传；`subagent_jobs` 查状态与摘要，`subagent_cancel` 取消。默认是前台（`false`）——只有当你不需要本轮就拿到结果时才值得后台化。

### 回传通道

子代理用 `deliver` 主动把 blocker、关键发现或提问推回主会话，而不是等主代理来问。`urgent: true` 会立即唤起一轮 follow-up，用在"计划行不通""撞上受保护文件""依赖缺失"这类需要主代理马上反应的情况。

### 编排辅助

- `optimize_prompt`：委托前把冗长模糊的任务压成清晰规格，可对每个任务自动执行（`optimizePrompt: true`）。
- `subagent_set_model`：某个代理的模型 429/不可用时，临时改道到可用模型；作用域为进程级，`/reload` 后仍生效，进程退出即清除。
- 每个任务都记账 `input` / `output` / `cacheRead` / `cacheWrite` / `cost` / `turns`。

模型分配在 `subagent-config.json`（`defaultModel`、`reviewModel`、`compactionModel`），也可由各 agent 的 frontmatter 覆盖。

## bridge 生命周期安全

`kipsel` 同时管一个 PiPilot bridge，它按四条规则约束自己：

- **单例**：全局只有一个 bridge。已有就复用，绝不重复起。
- **只收自己启的**：手动或用 systemd 启的 bridge 不归 `kipsel` 管，退出时不会去动它。
- **引用计数**：多个 `kipsel` 会话共用同一个 bridge，最后一个退出时才关。
- **降级不阻断**：bridge 目录缺失、依赖没装、启动失败，都不影响 grok-pi 本体启动——TUI 是主，桥是辅。

停止时按**进程组**终止。`npm start` 会派生出 `npm → sh → tsx → node` 四层，只杀 launcher 会留下孤儿继续占着 9377，所以这里整组回收。

```bash
kipsel-bridge status    # 持有者、归属、健康
kipsel-bridge stop      # 只停 kipsel 自己启的那个
```

## 安装

```bash
cp launcher/kipsel launcher/kipsel-bridge ~/.local/bin/
chmod +x ~/.local/bin/kipsel ~/.local/bin/kipsel-bridge
```

前提：Node 22+、`grok-pi` 二进制、以及 `~/Projects/pi_pilot/bridge` 已 `npm install`。任一项缺失时 `kipsel` 仍能启动 TUI。

可覆盖的环境变量：

| 变量 | 默认 |
|---|---|
| `KIPSEL_BRIDGE_DIR` | `~/Projects/pi_pilot/bridge` |
| `KIPSEL_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/kipsel` |
| `PIPILOT_PORT` | `9377` |
| `KIPSEL_NO_BRIDGE=1` | 完全不管 bridge |

### pi 定制层

`pi-fork/` 是 `~/.pi/agent` 的发行包（extensions / prompts / agents / themes / knowledge），提供上面的相位门控、六个专职代理与主题：

```bash
cd pi-fork
./install.sh            # 增量：extensions/prompts/agents 覆盖，knowledge/settings if-missing
./install.sh --force    # 全量覆盖（会覆盖 knowledge/，先确认备份）
./install.sh --dry-run
```

被覆盖的文件先备份到 `~/.pi/agent.backup.<时间戳>/`，回滚即拷回。

## 目录结构

```
launcher/                kipsel 命令 + kipsel-bridge 生命周期管理
pi-fork/                 pi 定制层发行包（工作流门控、子代理、主题）
tui-extension/           pi -e 桥接扩展核心
controller/              Node 22 controller（历史组件，见 docs/qq-bridge.md）
astrbot_plugin_kipsel/   AstrBot 插件（历史组件，见 docs/qq-bridge.md）
docs/                    文档与存档
```

## 验证

```bash
bash launcher/test-bridge-lifecycle.sh    # 21 项：单例/引用计数/外部不误杀/降级/孤儿回收/收尾自清理
```

`pi-fork/` 的验证方式见 `pi-fork/README.md`。

## 许可

MIT，见 `LICENSE`。主仓：`https://github.com/pashippercode/KiPSel`。
