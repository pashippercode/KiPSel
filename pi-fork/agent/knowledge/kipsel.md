# KiPSel knowledge（AstrBot ↔ 可见 pi TUI 桥接）

## 2026-08-14: 系统部署完成，位置与运维入口

1. 源码树 `/home/xubuntu/Projects/KiPSel`（非 git 仓库；`.git` 是受保护路径，无法仓库化）。三层：`controller/`（Node 22，无依赖）、`tui-extension/`（pi -e 扩展，strip-types 可运行）、`astrbot_plugin_kipsel/`（已部署到 kk 服务器）。
2. Controller 常驻：`systemctl --user status kipsel-controller`（单元文件 `~/.config/systemd/user/kipsel-controller.service`）。运行配置 `~/.config/kipsel/controller.json` + `bearer`（均 0600；bearer 只存哈希于配置）。外部 API `100.114.108.120:8787`（Tailscale + Bearer + 来源白名单），内部 API `127.0.0.1:8788`（每会话随机 token）。
3. 本地冒烟全通：可见 xterm → heartbeat(running) → 任务完成回收真实回复 → abort=interrupted → stop 关窗；`--no-session` 确认无会话落盘。
4. **远端已迁移**：生产服务器是 `ssh kk-new`（100.80.99.7，root SSH，容器 astrbot + snowluma 都在跑）；旧服务器 `kk-maintenance`（100.71.86.40）已废弃不要动。controller `allowedSources` 已切换为 `[100.114.108.120, 100.80.99.7]`。
5. **新插件首次加载的正确姿势**（server-maintenance skill 修复章）：不要 docker restart——用 dashboard `POST /api/v1/plugins/install/upload`（multipart zip，临时 JWT 由容器内 `cmd_config.json` 的 `dashboard.jwt_secret` 现铸，pyjwt 容器里有），定向安装+加载，不动其他 40+ 插件。注意：`/plugins/{name}/reload` 对**从未加载过**的插件会退化成 reload-all，别用它做首次加载。已在 AstrBot v4.27.3 实证。
6. kk-new 上备份：`/root/backups/astrbot-config-pre-kipsel-20260814184956.tar.gz`；误传旧服务器的插件保留未清理（用户指示不动旧机）。

## 关键 API 事实（以本机 pi 0.84.1 实证为准）

- `pi --no-session` + `--session-id <uuid>` 兼容：`SessionManager.inMemory(cwd, {id})`，不落盘且 `getSessionId()` 保留传入 id。用于「可见 TUI 但隐私不落盘」。
- 结果采集：marker（custom message）→ 等 `agent_settled`（`message_end` 时会话可能未持久化/未落定）→ 从 marker 到下一个 user 边界 harvest assistant 文本。
- `ctx.isIdle()` 在 agent run/重试/compaction 期间为 false；图片块扁平结构 `{type:"image", data, mimeType}`。
- `session_before_compact` / `session_before_switch` / `session_before_tree` 均可返回 `{cancel:true}` 锁定受管会话。
- AstrBot `CommandFilter` 会折叠空白并按空格 split → 多行 prompt 插件必须自己从 `event.get_message_str()` 解析原文（KiPSel 用单一 `/pi` 命令 + 内部子指令解析）。
- AstrBot 主动回发：`context.send_message(unified_msg_origin, MessageChain)`；`event.is_admin()`、`MessageType.FRIEND_MESSAGE` 做 ADMIN 私聊门禁。

## 运维注意

- lavenda 模型通道不稳定：zen-deepseek-v4-flash / zen-mimo-v2.5 / laguna-s-2.1-free 会整组 503 `model_not_found`；默认 `gpt-5.6-sol` 可用（402 配额 ~22:33 CST 重置）。冒烟测试前先 `pi --no-session -p "..."` 探活。
- 残留低概率竞态（review 已接受）：内网故障 ~80s 后 resume 重接纳的任务若 agent 已无输出会被判 `missing-assistant-result`；abort 与 dispatch 的极窄窗口已加 localInterruption 守卫。
- 测试基线：controller 12/12、TUI core 9/9、插件纯逻辑 43/43（main.py 依赖 astrbot 包，只能远端集成验证）。
