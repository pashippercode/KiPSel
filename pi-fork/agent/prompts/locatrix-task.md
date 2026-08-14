---
description: locatrix 分层任务入口：按层定位文件、选验证集、守完成定义
argument-hint: "<层: parser|runtime|editor|ui|content-pack|perf|boot> <任务描述>"
---

这是 locatrix 节奏游戏工程（Godot 4.4）的结构化任务。层：**$1**。任务：${@:-2}

## 铁律

- 仓库已 git 化：改动前 `git status` 确认基线干净；不顺手提交，完成时保持工作区只有本任务相关改动。
- 只动本层文件，不顺手重构其他模块（改谱面别碰 UI，改 UI 别碰 DSL 序列化）。
- 不留一次性 patch 脚本、debug 脚本、out/log 文件；临时产物用完即删。
- `backup/` 目录只读归档，禁止写入。
- 谱面坐标原点在中心、y-up（可视半宽 800 半高 450），勿套 Godot 屏幕 y-down。
- 改动 DSL 表面语法时必须同步：`scripts/chart/chart_parser.gd`、`scripts/edit/chart_doc.gd`、`tools/tree-sitter-locatrix/grammar.js`、`tools/zed-locatrix-chart/`。

## 层 → 入口文件

- **parser**：`scripts/chart/chart_parser.gd`、`scripts/chart/chart_time.gd`、`scripts/edit/chart_doc.gd`
- **runtime**：`scripts/play/play_controller.gd`、`scripts/play/playfield.gd`、`scripts/play/judgment.gd`、`scripts/autoload/content_loader.gd`
- **editor**：`scripts/edit/chart_editor.gd`、`scripts/edit/edit_timeline.gd`、`scripts/edit/chart_doc.gd`（注意 F7 是检查点回滚模型：退出会回滚到最近 Ctrl+S 检查点）
- **ui**：`scripts/ui/*.gd`、`scripts/autoload/scene_transition.gd`、`scenes/*.tscn`
- **content-pack**：`scripts/autoload/content_loader.gd`、`content/<pack>/`（info.yml 是手写解析的 YAML 小子集，勿假设完整 YAML）
- **perf**：同 runtime 入口，验证跑 perf 层脚本
- **boot**：`project.godot`、`scripts/autoload/*.gd`、`scenes/main.tscn`

## 验证

先跑最小冒烟集，再按层查 `tools/VALIDATE_INDEX.md` 选脚本（从仓库根）：

```sh
godot --headless --path . --script tools/validate_parse.gd
godot --headless --path . --script tools/validate_boot.gd
godot --headless --path . --script tools/validate_chart_load.gd
```

- 层=parser/runtime：补 `tools/validate_play_chart.gd`；runtime 热重载改动补 `tools/validate_hot_reload.gd`
- 层=editor：补 `tools/validate_editor.gd`、`tools/validate_editor_runtime.gd`
- 层=ui：按 VALIDATE_INDEX.md ui 节选择（`validate_settings_help.gd` 需 GL 真窗口，headless 环境跳过并说明）
- 层=content-pack：补 `tools/validate_content_pack_file.gd`
- 改了 DSL：额外人工读一遍 `content/contradiction/chart.txt` 与 `content/holdtest/chart.txt` 确认旧谱可解析

## 完成定义

1. 任务行为达成；2. 上述验证通过（如实标注 passed/failed/blocked）；3. `git status` 只剩本任务文件；4. 汇报：改动文件、验证结果、如何回滚（git 层面）。
