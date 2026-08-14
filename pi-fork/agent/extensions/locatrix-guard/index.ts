/**
 * locatrix-guard — Locatrix 项目安全守护扩展
 *
 * 合并 permission-gate + protected-paths，拦截危险操作并保护关键路径。
 *
 * 规则清单：
 * [R1] rm -r/-rf 变体（不区分大小写）
 * [R2] sudo
 * [R3] chmod/chown 777
 * [R4] mkfs
 * [R5] dd 写设备（of=/dev/）
 * [R6] git reset --hard
 * [R7] git clean -f
 * [P1] 任何路径包含 /backup/（locatrix 备份快照，只读）
 * [P2] ~/.pi/agent/auth.json（凭据文件）
 * [P3] 任何路径包含 /.git/（禁止直接改 git 内部）
 * [P4] 任何路径以 .env 结尾
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

// ── 危险命令正则 ──────────────────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\b.*\s-(?:r|f|RF|FR|rf|fR|rF|rr|ff|\S*r\S*f\S*|\S*f\S*r\S*)\b/i, label: "rm -r/-rf 变体" },        // [R1]
  { re: /\bsudo\b/i, label: "sudo" },                                                                               // [R2]
  { re: /\b(chmod|chown)\b[^;|&]*777/, label: "chmod/chown 777" },                                                   // [R3]
  { re: /\bmkfs\b/i, label: "mkfs" },                                                                               // [R4]
  { re: /\bdd\b[^;|&]*\bof=\/dev\//i, label: "dd 写设备" },                                                         // [R5]
  { re: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard" },                                                    // [R6]
  { re: /\bgit\s+clean\b.*-f\b/i, label: "git clean -f" },                                                          // [R7]
];

// ── 受保护路径模式 ─────────────────────────────────────────────

const AUTH_FILE = resolve(homedir(), ".pi/agent/auth.json"); // [P2]

/**
 * 将路径字符串转为绝对路径，处理 ~ 和相对路径。
 * [P4] .env 判断在原始路径上做（不需要 resolve）。
 */
function toAbsolutePath(raw: string, cwd: string): string {
  if (raw.startsWith("~")) {
    return raw.replace("~", homedir());
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  return resolve(cwd, raw);
}

/** 检查路径是否命中受保护规则，返回 reason 或 null。 */
function checkProtectedPath(rawPath: string, cwd: string): string | null {
  // [P4] .env 结尾 — 在原始路径上检查（文件名以 .env 结尾即可）
  if (rawPath.endsWith(".env")) {
    return `受保护路径: ${rawPath}（.env 文件，禁止写入）`;
  }

  const abs = toAbsolutePath(rawPath, cwd);

  // [P1] 包含 /backup/
  if (abs.includes("/backup/")) {
    return `受保护路径: ${abs}（/backup/ 目录为只读归档）`;
  }

  // [P2] auth.json
  if (abs === AUTH_FILE) {
    return `受保护路径: ${abs}（凭据文件，禁止写入）`;
  }

  // [P3] 包含 /.git/
  if (abs.includes("/.git/")) {
    return `受保护路径: ${abs}（禁止直接修改 .git 内部）`;
  }

  return null;
}

/** 从 bash command 字符串中提取可能的文件路径参数，逐一检查受保护规则。 */
function checkProtectedInCommand(command: string, cwd: string): string | null {
  // 简单启发：空格分词后，以 / 或 ~ 或 . 开头且包含 / 的 token 视为路径
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    if (token === "") continue;
    // 跳过 flag
    if (token.startsWith("-")) continue;
    // 跳过命令名本身（无 / 的短 token）
    if (!token.includes("/") && !token.startsWith("~") && !token.startsWith("./")) continue;

    const reason = checkProtectedPath(token, cwd);
    if (reason) return reason;
  }
  return null;
}

// ── 扩展主函数 ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // ─── 危险 bash 命令拦截 ──────────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;

      for (const { re, label } of DANGEROUS_PATTERNS) {
        if (re.test(command)) {
          if (!ctx.hasUI) {
            return { block: true, reason: `危险命令已拦截 (${label})：在非交互模式下不允许执行` };
          }
          const choice = await ctx.ui.select(
            `⚠️ 检测到危险命令 (${label})：\n\n  ${command}\n\n是否允许执行？`,
            ["允许", "拦截"],
            // RPC 模式（PiPilot headless）下无人应答会永久挂起；超时回退 undefined = 拦截（默认拒绝）
            { timeout: 120_000 },
          );
          if (choice !== "允许") {
            return { block: true, reason: `用户拦截了危险命令 (${label})` };
          }
        }
      }
    }

    // ─── 受保护路径：write / edit 工具 ───────────────────────
    if (event.toolName === "write" || event.toolName === "edit") {
      const rawPath = (event.input as { path?: string }).path;
      if (rawPath) {
        const reason = checkProtectedPath(rawPath, cwd);
        if (reason) {
          return { block: true, reason };
        }
      }
    }

    // ─── 受保护路径：bash 工具（检查 command 中的路径）────────
    if (isToolCallEventType("bash", event)) {
      const reason = checkProtectedInCommand(event.input.command, cwd);
      if (reason) {
        return { block: true, reason };
      }
    }

    return undefined;
  });
}
