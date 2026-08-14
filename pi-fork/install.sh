#!/usr/bin/env bash
# KiPSel pi-fork installer
# 把本目录下的定制层（extensions / prompts / agents / knowledge / 配置）应用到 ~/.pi/agent。
# 用法: ./install.sh [--force] [--dry-run]
set -euo pipefail

AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent"
BACKUP_DIR="$HOME/.pi/agent.backup.$(date +%Y%m%d-%H%M%S)"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			echo "用法: $0 [--force] [--dry-run]"
			echo "  --force    覆盖所有文件（含 subagent-config.json / settings.json / knowledge）"
			echo "  --dry-run  只打印将要执行的操作，不写任何文件"
			exit 0
			;;
		*)
			echo "unknown arg: $arg" >&2
			exit 2
			;;
	esac
done

if [ ! -d "$SRC_DIR" ]; then
	echo "错误: 找不到定制层目录 $SRC_DIR" >&2
	exit 1
fi

backed_up=0
ensure_backup() {
	if [ "$DRY_RUN" = 1 ]; then return; fi
	if [ "$backed_up" = 0 ]; then
		mkdir -p "$BACKUP_DIR"
		backed_up=1
	fi
}

# 备份一个将被覆盖的目标文件（保留相对路径）
backup_dest() {
	local dest="$1"
	if [ "$DRY_RUN" = 1 ] || [ ! -e "$dest" ]; then return; fi
	ensure_backup
	local rel="${dest#$AGENT_DIR/}"
	mkdir -p "$(dirname "$BACKUP_DIR/$rel")"
	cp -a "$dest" "$BACKUP_DIR/$rel"
}

# policy: always | if-missing
copy_file() {
	local src="$1" policy="$2"
	local rel="${src#$SRC_DIR/}"
	local dest="$AGENT_DIR/$rel"
	if [ "$policy" = "if-missing" ] && [ -e "$dest" ] && [ "$FORCE" != 1 ]; then
		[ "$DRY_RUN" = 1 ] && echo "skip   $rel (目标已存在)"
		return
	fi
	if [ "$DRY_RUN" = 1 ]; then
		echo "copy   $rel"
	else
		backup_dest "$dest"
		mkdir -p "$(dirname "$dest")"
		cp -a "$src" "$dest"
		echo "copy   $rel"
	fi
}

# 目录递归：每个文件按 policy 处理
copy_tree() {
	local rel_dir="$1" policy="$2"
	local src="$SRC_DIR/$rel_dir"
	[ -d "$src" ] || return 0
	while IFS= read -r -d '' f; do
		copy_file "$f" "$policy"
	done < <(find "$src" -type f -print0)
}

copy_tree "extensions" "always"
copy_tree "prompts" "always"
copy_tree "agents" "always"
copy_tree "knowledge" "if-missing"
copy_file "$SRC_DIR/AGENTS.md" "always"
copy_file "$SRC_DIR/APPEND_SYSTEM.md" "always"
copy_file "$SRC_DIR/keybindings.json" "always"
copy_file "$SRC_DIR/subagent-config.json" "if-missing"
copy_file "$SRC_DIR/settings.json" "if-missing"

if [ "$DRY_RUN" = 1 ]; then
	echo "(dry-run: 未写任何文件)"
	exit 0
fi

if [ "$backed_up" = 1 ]; then
	echo "备份: $BACKUP_DIR"
fi

cat <<'EOF'

安装完成。生效步骤:
  1. 在 pi TUI 中执行 /reload（新工具 deliver / optimize_prompt 需要重载扩展）。
  2. 验证: 任意会话里问 agent "调用 optimize_prompt 优化 'fix the thing'"，或让子代理 deliver 一条消息。
  3. 回滚: 备份目录在 ~/.pi/agent.backup.*，把里面的文件拷回 ~/.pi/agent 即可。
EOF
