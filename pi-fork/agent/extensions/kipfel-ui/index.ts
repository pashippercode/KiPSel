// kipfel-ui — Kipfel（橙棕小可颂）TUI 外观扩展。
// 以 Claude Code 欢迎屏为蓝本定制系统 UI 提示文字：像素画 mascot header + 欢迎/提示文案
// + Kipfel 风味 working message。颜色全部取自当前主题（不用裸 ANSI）。
// 防御式设计：任何异常都静默回退（简版标题 / 内置 header / 默认提示），绝不影响 TUI 可用性。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// 像素画仅使用 █ ▄ ▀ ░ 与空格（无宽字符，避免终端错位）。
const KIPFEL_ART: string[] = [
	" ▄██▄       ▄██▄",
	" █████████████████",
	" ██░░░░░░░░░░░░░██",
	" ██░▀▀░░░░░░░▀▀░██",
	"  ▀█▄▄▄▄▄▄▄▄▄▄█▀",
];

const WORKING_MESSAGE = "🥐 Kipfel 揉面团中…";

export default function kipfelUiExtension(pi: ExtensionAPI): void {
	try {
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			try {
				if (ctx.mode !== "tui") return;
				ctx.ui.setHeader((_tui, theme) => {
					try {
						const lines: string[] = [];
						for (const row of KIPFEL_ART) {
							lines.push(theme.fg("accent", row));
						}
						lines.push("");
						lines.push(theme.bold(theme.fg("accent", "KiPSel pi-fork")) + theme.fg("dim", "  v0.2.0 · pi 0.84.1"));
						lines.push(theme.fg("muted", "🥐 Welcome! Kipfel 已就位 — workflow 是本环境的旗舰特色"));
						lines.push(
							theme.fg("dim", "/work <任务> 启动工作流") +
								theme.fg("muted", " · ") +
								theme.fg("dim", "/ 查看命令") +
								theme.fg("muted", " · ") +
								theme.fg("dim", "! 运行 bash"),
						);
						return new Text(lines.join("\n"), 0, 0);
					} catch {
						return new Text("KiPSel pi-fork v0.2.0", 0, 0);
					}
				});
				ctx.ui.setWorkingMessage(WORKING_MESSAGE);
			} catch {
				// 静默失败：保留内置 header 与默认 working message。
			}
		});
	} catch {
		// 静默失败：扩展不注册任何 UI，内置界面完全不受影响。
	}
}
