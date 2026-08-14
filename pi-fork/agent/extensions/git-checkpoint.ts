/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 *
 * Adaptation: silently no-ops when the session is not inside a git repository.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;
	let isGitRepo = false;

	// Detect git repository once at session start; disable entire extension if not a repo
	pi.on("session_start", async () => {
		try {
			const { stdout } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			isGitRepo = stdout.trim() === "true";
		} catch {
			isGitRepo = false;
		}
	});

	// Track the current entry ID when user messages are saved
	pi.on("tool_result", async (_event, ctx) => {
		if (!isGitRepo) return;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async () => {
		if (!isGitRepo) return;
		// Create a git stash entry before LLM makes changes
		const { stdout } = await pi.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!isGitRepo) return;
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		// 带超时：RPC 模式无人应答时自动落 undefined = 不恢复（安全默认）
		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		], { timeout: 60_000 });

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	pi.on("agent_end", async () => {
		// Clear checkpoints after agent completes
		checkpoints.clear();
	});
}
