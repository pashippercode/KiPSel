#!/usr/bin/env bash
# kipsel-bridge 生命周期泛用性验证。
#
# 覆盖:单例复用、引用计数、外部 bridge 不被误杀、缺失目录降级、
#       僵尸持有者自愈、整组终止不留孤儿、缺依赖降级。
#
# 全程使用隔离的 STATE_DIR 与端口 9477,不碰真实的 9377 bridge。
# 沙箱会回收跨调用的后台进程,所以整段必须在一次调用里跑完。
set -uo pipefail

CTL="$HOME/Projects/KiPSel/launcher/kipsel-bridge"
STATE="/home/xubuntu/.cache/kipsel-bridge-test"
PORT=9477
export KIPSEL_STATE_DIR="$STATE"
export PIPILOT_PORT="$PORT"
export PIPILOT_HOST=127.0.0.1
export PIPILOT_P2P_ENABLED=false
export KIPSEL_BRIDGE_LOG="$STATE/bridge.log"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1: expected [$3] got [$2]"; fi; }

# ensure 是"先等健康检查、再写持有者与归属记录",所以健康刚变 true 时
# 记录可能还没落盘。断言前必须先等目标状态稳定,否则测的是竞态。
wait_until() { # wait_until <描述> <超时秒> <命令...>
	local desc="$1" timeout="$2"; shift 2
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if "$@" >/dev/null 2>&1; then return 0; fi
		sleep 0.3
	done
	echo "  (等待超时: $desc)"
	return 1
}
holders_are() { [[ "$(holders)" == "$1" ]]; }
owned()      { [[ -n "$(pgid_of)" ]]; }
not_owned()  { [[ -z "$(pgid_of)" ]]; }
kill_port()  { fuser -k -n tcp "$PORT" >/dev/null 2>&1 || true; }

health()  { curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; }
holders() { ls "$STATE/holders" 2>/dev/null | wc -l | tr -d ' '; }
pgid_of() { [[ -f "$STATE/bridge.owner" ]] && sed -n 's/^pgid=//p' "$STATE/bridge.owner" | head -1 || echo ""; }
# 一条 bridge 在命令行上有 sh / tsx / node 三层匹配,所以按**进程组**数计。
bridge_groups() { ps -eo pgid,cmd | grep "[s]erver\.ts" | awk '{print $1}' | sort -u | wc -l | tr -d ' '; }

# 起一个"长命会话":ensure 后一直活着,直到出现释放标志文件。
# 这模拟真实的 kipsel TUI 会话(而不是 bash -c 那样立刻退出)。
start_session() {
	local tag="$1"
	rm -f "$STATE/release-$tag"
	(
		# 与真实 wrapper 一致:用**会话进程自身**的 pid 登记持有者。
		KIPSEL_HOLDER_PID="$BASHPID" "$CTL" ensure >/dev/null 2>&1
		while [[ ! -f "$STATE/release-$tag" ]]; do sleep 0.3; done
		KIPSEL_HOLDER_PID="$BASHPID" "$CTL" release >/dev/null 2>&1
	) >/dev/null 2>&1 &
	echo $!
}
end_session() { touch "$STATE/release-$1"; }

kill_port
rm -rf "$STATE"; mkdir -p "$STATE"

echo "=== 1. 无 bridge 时 ensure 拉起一个 ==="
s1="$(start_session a)"
for i in $(seq 1 40); do health && break; sleep 0.5; done
health && ok "bridge 已就绪" || bad "bridge 未就绪"
wait_until "归属记录落盘" 15 owned
wait_until "持有者登记" 15 holders_are 1
p1="$(pgid_of)"
[[ -n "$p1" ]] && ok "记下归属 pgid=$p1" || bad "无归属记录"
check "持有者数量" "$(holders)" "1"

echo
echo "=== 2. 第二个会话 ensure:复用同一个 bridge(单例,不重复起) ==="
s2="$(start_session b)"
sleep 1
check "pgid 未变(没有起第二个)" "$(pgid_of)" "$p1"
check "持有者数量" "$(holders)" "2"
check "bridge 进程组数" "$(bridge_groups)" "1"

echo
echo "=== 3. 会话 a 退出:计数剩 1,bridge 必须活着 ==="
end_session a
for i in $(seq 1 30); do [[ "$(holders)" == "1" ]] && break; sleep 0.5; done
check "持有者数量" "$(holders)" "1"
health && ok "bridge 仍在跑(引用计数生效)" || bad "bridge 被提前关掉"

echo
echo "=== 4. 最后一个会话退出:才关掉 bridge ==="
end_session b
for i in $(seq 1 40); do health || break; sleep 0.5; done
health && bad "bridge 应已停止" || ok "bridge 已停止"
# release 是"先杀进程、再删归属记录",健康先失败属于正常窗口,这里等记录清空。
wait_until "归属记录清除" 10 not_owned
[[ -z "$(pgid_of)" ]] && ok "归属记录已清除" || bad "归属记录残留"
check "无孤儿 server.ts 进程组" "$(bridge_groups)" "0"
wait "$s1" "$s2" 2>/dev/null

echo
echo "=== 5. 外部启动的 bridge:kipsel 退出时绝不误杀 ==="
( cd "$HOME/Projects/pi_pilot/bridge"
  setsid nohup npm start >>"$STATE/external.log" 2>&1 & echo $! >"$STATE/.ext_pid" )
ext="$(cat "$STATE/.ext_pid" 2>/dev/null)"
for i in $(seq 1 40); do health && break; sleep 0.5; done
health && ok "外部 bridge 已就绪" || bad "外部 bridge 未就绪"
s3="$(start_session c)"
sleep 1
[[ -z "$(pgid_of)" ]] && ok "识别为外部,未登记归属" || bad "把外部 bridge 错登记成自己启的"
end_session c
sleep 3
health && ok "外部 bridge 未被误杀" || bad "外部 bridge 被误杀"
kill -TERM -- "-$ext" 2>/dev/null || true
sleep 2; kill -KILL -- "-$ext" 2>/dev/null || true
kill_port
sleep 1

echo
echo "=== 6. 僵尸持有者自愈(会话被 kill,计数不该泄漏) ==="
s4="$(start_session d)"
sleep 1
kill -KILL "$s4" 2>/dev/null || true   # 模拟会话被强杀,来不及 release
sleep 1
n="$("$CTL" status 2>/dev/null | sed -n 's/^holders *: *//p')"
check "死持有者被清理后计数" "$n" "0"

echo
echo "=== 7. bridge 目录缺失时优雅降级 ==="
# 必须先确认没有任何 bridge 在跑,否则 ensure 会走"复用"分支而不是降级分支。
kill_port
for i in $(seq 1 20); do health || break; sleep 0.5; done
out="$(KIPSEL_BRIDGE_DIR=/nonexistent/bridge "$CTL" ensure 2>&1)"; rc=$?
check "退出码仍为 0" "$rc" "0"
[[ "$out" == *"跳过 bridge"* ]] && ok "给出跳过原因" || bad "缺少跳过提示: $out"

echo
echo "=== 8. stop 拒绝停止非自己启的 bridge ==="
# 清掉归属记录以模拟"bridge 不是 kipsel 启的"这一前提(step 6 强杀会话
# 留下了残留记录)。
rm -f "$STATE/bridge.owner"
out="$("$CTL" stop 2>&1)"
[[ "$out" == *"拒绝停止"* ]] && ok "拒绝停止外部 bridge" || bad "stop 行为异常: [$out]"

echo
echo "=== 9. 未安装依赖时拒绝启动 ==="
FAKE="$STATE/fake-bridge"; mkdir -p "$FAKE"
out="$(KIPSEL_BRIDGE_DIR="$FAKE" "$CTL" ensure 2>&1)"
[[ "$out" == *"未安装依赖"* ]] && ok "检测到缺依赖并跳过" || bad "缺依赖处理异常: [$out]"

echo
kill_port
rm -rf "$STATE"
echo "════════════════════════════════"
echo "PASS=$pass  FAIL=$fail"
[[ "$fail" -eq 0 ]] || exit 1
