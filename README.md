# KiPSel

通过 QQ 私聊（AstrBot ADMIN）远程驱动本机 pi TUI 的轻量桥接项目。

> **状态说明**：三层代码均已实现并通过各自的单元测试：controller（Node `node:test`，12/12）、TUI extension core（Node `--experimental-strip-types`，9/9）、AstrBot 插件纯逻辑（Python `unittest`，43/43）。controller ↔ extension ↔ QQ 的真实端到端链路尚未完成验收，标注为「待验证」。

## 架构总览（三层）

```
QQ 私聊 ──AstrBot ADMIN 插件──▶ 本机 Node 22 controller ──▶ 最多 3 个可见 xterm（pi -e 会话）
        ◀──（结果回发）────── controller ────────────────◀── agent_settled 后主动回发
```

1. **AstrBot ADMIN 私聊插件（层 1）**
   - 仅处理私聊中的 `/pi` 命令与 `ask` 内容，按 **alias 维护独立的内存 FIFO 队列**。
   - 队列与状态全部驻留内存：**不落盘、不持久化**，进程重启即清空。
2. **本机 Node 22 controller（层 2）**
   - 运行在本机（Tailscale 网段内），只对外暴露一个 HTTP 端口。
   - 负责接收插件投递的任务、转交给对应 alias 的 TUI 会话，并把结果回传给插件。
   - 管理**最多 3 个 controller-owned 的可见 xterm**（桌面可见，便于直接观察 TUI）；超出上限的任务进入队列等待。
3. **pi TUI 会话（层 3）**
   - 每个会话由 controller 以 `pi -e <extension>` 启动，**单次加载 KiPSel 桥接 extension**。
   - extension 把收到的文本/图片注入当前 alias 的会话，并在 **`agent_settled` 事件**（agent 完全收尾、无重试/续跑/排队续接）后**主动把结果回发**：controller → 插件 → QQ。

### 数据流（一次 ask）

1. 用户私聊发送 `/pi ask <文本>`，可**同消息附带图片**。
2. 插件校验命令，将「文本 + 图片」按**当前 alias** 推入内存 FIFO。
3. 插件经 **Tailscale + Bearer** 调用 controller API 投递任务。
4. controller 把任务交给该 alias 的 TUI extension；同一 alias 串行处理，不同 alias 并行（并发上限 3）。
5. extension 收到 `agent_settled` 后回传结果 → controller → 插件 → 私聊回复。

## 命令（私聊消息，前缀 `/pi`）

| 命令 | 说明 |
|------|------|
| `/pi start <alias> [project] [profile]` | 为 alias 启动一个 TUI 会话；可选 project/profile，二者均须在白名单内 |
| `/pi stop [force]` | 停止当前 alias 的会话；`force` 强制终止 |
| `/pi list` | 列出会话、队列与各 alias 状态 |
| `/pi use <alias>` | 切换当前 alias（后续 `ask` 进入该 alias） |
| `/pi ask <文本>` | 文本进入当前 alias 队列；可同消息附图片 |
| `/pi queue` | 查看队列（等待中的消息） |
| `/pi cancel` | 取消队列中尚未开始的任务 |
| `/pi abort` | 中止当前正在执行的任务（保留会话，不杀进程） |

## 约束与安全

- **project / profile 白名单**：`start` 时校验 project 与 profile，不在白名单内直接拒绝；白名单内容在配置中维护。
- **vision profile**：图片输入仅对 vision profile 的会话开放；非 vision profile 会话提交带图任务时直接拒绝（插件与 controller 双重校验）。
- **默认限制（可配置）**：并发 TUI 会话上限 3；每 alias 队列长度上限、每消息图片数量/单图大小上限均有默认值，可在插件配置中调整。具体默认数值在实现阶段确定并写入配置说明。
- **内存隐私**：队列、会话状态与消息内容仅存于内存；不写明文日志、不落盘、不持久化，重启即清空。
- **私网地址 + Bearer**：插件只允许把 controller_url 指向非公网字面 IPv4（loopback / RFC1918 私网 / Tailscale CGNAT 100.64.0.0/10），必须 http + 显式端口；公网、链路本地（169.254/16，含云元数据地址）、域名与 IPv6 一律拒绝。请求须携带 Bearer token；controller 额外按来源 IP 白名单拒绝请求。推荐部署形态仍是 Tailscale 网段。
- **四项进程 ownership 校验**：controller 只管理自己启动的进程，执行 `stop`/`abort` 前通过四项校验确认归属，防止误杀无关进程（具体机制以实现阶段为准）：
  1. 进程须由 controller 自身 spawn（记录 PID 与启动时间）；
  2. 会话携带 controller 生成的唯一标识；
  3. 进程命令行/工作目录符合预期的 `pi -e` 启动形态；
  4. 操作前复核 PID 仍存活且仍在本 controller 的管理列表中（避免 PID 复用）。
- **不碰现有 TUI / PiPilot**：KiPSel 只操作自己启动的 xterm/pi 会话；不读取、不接管、不修改用户现有的 pi TUI 会话，也不与 PiPilot 桥接交互。
- **会话不落盘**：controller 以 `--no-session` 启动 pi（ephemeral），prompt、图片与模型回复不会写入 pi 会话文件；会话 ID 由 `--session-id` 固定，用于 ownership 校验。
- **图片来源限制**：http(s) 图片下载前逐跳校验解析结果必须是公网 IP（拒绝 loopback/私网/CGNAT/元数据地址；DNS 在连接时会重解析，该项是缓解而非完整防 rebinding）；本地文件来源仅允许 AstrBot 数据目录之内的路径。
- **信任模型明示**：内部 API 的每会话 token 经环境变量传入，同用户进程可读 `/proc/<pid>/environ`；controller 状态文件（0600）含 owner marker 与 token 哈希，属敏感文件。KiPSel 的信任边界是「本机同用户 + Tailscale 网段」。

## 环境要求（本机）

- Node 22+（controller 运行时）。
- AstrBot（插件宿主，私聊 ADMIN）。
- Tailscale 或任意私网互通（controller 只监听你指定的网段地址；推荐 Tailscale）。

## 目录结构

```
astrbot_plugin_kipsel/   # AstrBot 插件（层 1）：main.py 命令入口、queueing.py 内存 FIFO、client.py controller 客户端、media.py 纯内存图片读取
controller/              # Node 22 controller（层 2）：server.mjs、registry.mjs、server.test.mjs、systemd 模板
tui-extension/           # pi -e 桥接扩展（层 3）：core.ts（纯核心，可独立测试）、index.ts（pi 运行时入口）
```

## 安装（AstrBot 插件）

插件以独立镜像仓库发布（仓库根即插件文件，符合 AstrBot 插件布局）：

- 仓库：`https://github.com/pashippercode/astrbot_plugin_kipsel`
- AstrBot 仪表盘「插件 → 安装」填该仓库地址，或调用 `POST /api/v1/plugins/install/git`。
- 本 mono 仓库（controller + tui-extension + 插件）是源码主仓；插件镜像仓随发布手动同步。

安装后在仪表盘配置 `controller_url` 与 `controller_bearer`（键名见 `_conf_schema.json`，切勿凭记忆写配置键）。

## 安装 / 测试 / 回滚（高层顺序）

1. **安装**：将 AstrBot 插件放入插件目录并启用（保留插件包备份）→ 本机准备 controller（Node 22，安装依赖）→ 编写并放置桥接 extension → 配置白名单、默认限制、Bearer 与 Tailscale 连通性。
2. **测试**：先做 controller ↔ extension 本地联调回路 → 再做最小端到端（私聊 → 插件 → controller → TUI → 回发）→ 逐步覆盖全部命令、多 alias 并发、图片与队列限制、ownership 校验。只有实际跑通的项才在文档中标注为已通过。
3. **回滚**：任一环节失败时，停 controller → 卸载插件 → 恢复安装前备份；extension 与 controller 可独立替换/重启，不影响现有 TUI 与 PiPilot。

## 仓库与许可

- 本 README 按 **GitHub-ready** 标准撰写：不含真实 endpoint、token、QQ ID 或聊天内容，可直接随仓库发布。
- 主仓：`https://github.com/pashippercode/KiPSel`；插件镜像仓：`https://github.com/pashippercode/astrbot_plugin_kipsel`。
- 许可：MIT（见 LICENSE）。
