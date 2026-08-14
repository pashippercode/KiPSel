---
description: 按 locatrix-g 工程规范跑 headless 验证（备份→验证→残留审计→汇报）
argument-hint: "[改动范围: parser|runtime|editor|ui|scene]"
---
在 ~/Work/locatrix-g 完成改动收尾验证。范围：${1:-runtime}。

规则（来自工程 .agents/skills/locatrix-editing，覆盖其中的 Windows 路径）：
- 本机 godot 二进制（project.godot features=4.4）：`~/Downloads/godot441/Godot_v4.4.1-stable_linux.x86_64`（4.5 备选 `~/Downloads/godot45/...`）
- 也可直接用封装：`godot-h <script> [timeout]`（已 source ~/.bashrc.pi 时可用，含超时+残留审计）
- 一律 headless 串行：`godot --headless --path . --script tools/<validator>.gd`，必须设超时；不要启动项目管理器/可视编辑器收尾
- 按范围选最小验证：
  - editor / chart_doc 文本写回 → tools/validate_editor.gd
  - content 加载 / parser → tools/validate_chart_load.gd
  - play 启动链路 → tools/validate_play_chart.gd
  - F5/F6 热重载 → tools/validate_hot_reload.gd
  - 仅脚本编译烟测 → tools/validate_parse.gd
  - UI / 场景切换 → tools/validate_ui_refactor.gd 和 tools/validate_scene_transition.gd（两者截图到 build/，输出 UI_REFACTOR_OK / SCENE_TRANSITION_OK；跑完还原 content/holdtest/chart.txt）
- 若改动 DSL 语法，读一遍 content/contradiction/chart.txt 与 content/holdtest/chart.txt 确认旧谱仍可解析
- 收尾：检查本次验证启动的 godot 进程是否已退出（ps -eo pid,etimes,cmd | grep '[g]odot'，且 etimes 小）；`ObjectDB instances leaked at exit` 不是可忽略成功，先显式 queue_free 场景复跑
- git 工作区若有未提交改动，验证通过后再汇报；不要在未验证前就 commit
