# locatrix 知识库

## 2026-08-12 打包 + 真机性能测试管线

**导出命令**（godot45 = ~/Downloads/godot45/Godot_v4.5-stable_linux.x86_64）：
- `godot45 --headless --path ~/Work/locatrix-g --export-debug "Linux" build/linux/locatrix.x86_64`（77MB，tpl45 linux_debug 模板）
- `... --export-debug "Android" build/android/locatrix-signed.apk`（45MB，keystore 在 preset 内）
- 首次 headless 导出需 7~8 分钟（资源遍历），勿误判卡死； timeout ≥ 540s。

**Android 安装三坑**：
1. 旧版签名冲突 → `adb uninstall com.locatrix.rhythm` 后重装。
2. streamed install 可能触发 `dlopen libgodot_android.so: Timer expired` 崩溃 → 改 `adb push /data/local/tmp/ + pm install`。
3. `adb devices` 显示 unauthorized → 手机上确认 USB 调试弹窗。

**真机 FPS 无注入测量**（不改动游戏代码）：
- `dumpsys gfxinfo` 对 Godot SurfaceView 无效（Total frames=0），弃用。
- Android：`dumpsys SurfaceFlinger --list` 找 `SurfaceView[...](BLAST)#<id>`，再 `--latency '<层名带#id>'` 取呈现时间戳，python 合并差分算帧时间（缓冲仅 127 帧，多次采样合并）。
- 桌面：导出包带 `--print-fps`（每秒一行 stdout），`xdotool search --pid <pid>` 找窗（--name 中文不稳）+ `mousemove --window <wid> x y click 1` 驱动进 gameplay。
- scrot 可截全屏确认场景状态；`import`(ImageMagick) 未装。

**性能基线（2026-08-12，谱面为 2-note 桩谱，仅代表基线负载）**：
- vivo V2118A（SD870 级/Android 14/60Hz 模式）：锁 60fps，ft avg=16.67ms p95=16.74 max=16.95，0 帧>17ms。
- xubuntu-pc 桌面（Intel HD 2500 IVB/Mesa 25.2.8）：菜单 74fps；gameplay 34~62fps 波动；进 play 场景有 ~1.0s 停顿（59MB wav 同步解码）。
- `tools/validate_perf_density.gd`（500 notes/20 活跃 clip）：avg=1.868ms > 1.5ms 预算 → PERF_BUDGET_EXCEEDED，低端机密谱有掉帧风险。

**磁盘纪律**（本机常态 6.2G 余量）：导出前 `mv` 旧产物为 `.bak`，新产物验证通过后删 `.bak`；本轮双平台导出净增量 ≈0。导出日志含 keystore 密码（apksigner 命令行），用完即删。

**workflow-audit 协作**：phase 只能由用户在 TUI `/audit-phase <plan|active|review|verify|capture>` 切换；agent 无法调用。未切 active 时 write/edit 全被拦 → 改用无注入 bash 方案替代写临时脚本。capture-lesson agent 不存在，capture 阶段由主代理直接 write 本文件。

## 2026-08-12 触点/设置页/音量工作流

1. 触点链路优化：project.godot 设 `input_devices/buffering/use_accumulated_input=false`（Godot 4.4+ 默认按 60Hz 物理帧合批触摸事件，是"触点球更新率低"主因）；playfield.gd `_draw_bg_grid` 触点脉动/涟漪高斯循环加 3σ=450px 空间裁剪（RIPPLE_CULL），多触点 exp 调用从 段数×触点 降为窗口内段数×触点。
2. 120Hz 限制：Godot 4.5 Android 无请求高刷 API（DisplayServer 仅 screen_get_refresh_rate 读）；系统 peak_refresh_rate=144 但 vivo 仍给游戏 60Hz 模式 → 需系统侧白名单/强制，引擎内无解（残余）。
3. 设置页重设计约束：validate_settings_screen.gd 硬依赖"场景首个 OptionButton=score_disp_mode"、BG ColorRect、SpinBox 存在；validate_settings_layout.gd 用 `_relayout(force_width)` 注入宽度（无头显示服务器忽略 root.size）。
4. 不改 play_controller.gd 的音频方案：AudioDirector autoload 监听 SceneTree.node_added("SfxTap")→deferred 写 play_controller.sfx_tap（_play_sfx_tap 每播前同步 player.stream）+ 写 $Audio/SfxGlide/SfxSection/SfxTap volume_db；正解音延迟=合成 wav 前置静音（AudioStreamWAV FORMAT_16_BITS 22050Hz，C7→G6 下滑+6ms 敲击头）。
5. 真机验证管线：adb push+pm install（避 streamed install 的 dlopen Timer expired）→ monkey 启动 → input tap 坐标驱动 → exec-out screencap 截图人工核对；新设置页在 2408x1080 下 3 列瓷砖无超界。
6. 验证器套件：validate_parse/settings_screen/settings_layout/audio_director/ui_refactor/ui_clickable/touch_autoplay/audio_load/play_chart 全绿；validate_perf_density 超预算为先前基线（1.87→2.01ms 波动，非本次回归，该基准只测 play_controller._update_xforms）。
