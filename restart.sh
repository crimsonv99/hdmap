#!/usr/bin/env bash
#
# restart.sh — start / stop / restart the hdmap tool.
#
#   ./restart.sh            restart (stop if running, then start)  <- the usual one
#   ./restart.sh start      start only (fails if already running)
#   ./restart.sh stop       stop it
#   ./restart.sh status     is it up? show pid + url
#   ./restart.sh logs       tail the live log (Ctrl-C to quit)
#
#   PORT=9000 ./restart.sh  use a different port (default 8097)
#
# The server is started DETACHED (nohup + disown), so it keeps running after you
# close this terminal. It does NOT survive a reboot — run this again after one.

set -u

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8097}"
URL="http://localhost:${PORT}/"
LOG="logs/server-stdout.log"
BOOT_TIMEOUT=60   # seconds to wait for the first HTTP 200 (startup does an osm2streets rebuild)

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; N=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi
ok()   { printf "%s✓%s %s\n" "$G" "$N" "$1"; }
warn() { printf "%s!%s %s\n" "$Y" "$N" "$1"; }
err()  { printf "%s✗%s %s\n" "$R" "$N" "$1" >&2; }
info() { printf "  %s\n" "$1"; }

# --- helpers -----------------------------------------------------------------
# pid(s) currently LISTENING on $PORT (empty if none)
listener_pids() { lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null; }

is_up() { curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; }

require_node() {
  command -v node >/dev/null 2>&1 || { err "node is not installed. Install Node >= 18 from https://nodejs.org"; exit 1; }
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [ -n "$major" ] && [ "$major" -lt 18 ] 2>/dev/null; then
    err "Node $(node -v) is too old — hdmap needs Node >= 18."; exit 1
  fi
}

require_deps() {
  if [ ! -d node_modules ]; then
    warn "node_modules missing — running 'npm install' first (one time, ~1 min)…"
    npm install || { err "npm install failed."; exit 1; }
  fi
}

# --- commands ----------------------------------------------------------------
do_stop() {
  local pids
  pids="$(listener_pids)"
  if [ -z "$pids" ]; then
    info "nothing running on port ${PORT}"
    return 0
  fi
  info "stopping pid(s): $(echo "$pids" | tr '\n' ' ')"
  # ask nicely first (the server logs a clean session-end on SIGTERM)
  echo "$pids" | xargs kill 2>/dev/null

  local i=0
  while [ $i -lt 10 ]; do
    sleep 0.5
    [ -z "$(listener_pids)" ] && { ok "stopped"; return 0; }
    i=$((i + 1))
  done

  warn "still alive after 5s — forcing (kill -9)"
  listener_pids | xargs kill -9 2>/dev/null
  sleep 1
  if [ -z "$(listener_pids)" ]; then ok "stopped (forced)"; return 0; fi
  err "could not free port ${PORT}. Check: lsof -i tcp:${PORT}"
  return 1
}

do_start() {
  if [ -n "$(listener_pids)" ]; then
    err "already running on port ${PORT} (pid $(listener_pids | tr '\n' ' ')). Use ./restart.sh to restart."
    return 1
  fi

  require_node
  require_deps
  mkdir -p logs

  info "starting server on port ${PORT}…"
  # detach fully so it survives this terminal closing
  PORT="$PORT" nohup node server.mjs >>"$LOG" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true

  # startup runs an osm2streets rebuild (a few seconds) before it answers
  printf "  waiting for %s " "$URL"
  local i=0
  while [ $i -lt "$BOOT_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf "\n"; err "server exited during startup. Last log lines:"
      tail -20 "$LOG" >&2
      return 1
    fi
    if is_up; then
      printf "\n"; ok "hdmap is up  →  ${B}${URL}${N}"
      info "pid $pid · log: ${LOG}"
      return 0
    fi
    printf "."
    sleep 1
    i=$((i + 1))
  done

  printf "\n"; err "timed out after ${BOOT_TIMEOUT}s. Last log lines:"
  tail -20 "$LOG" >&2
  return 1
}

do_status() {
  local pids
  pids="$(listener_pids)"
  if [ -n "$pids" ] && is_up; then
    ok "running  →  ${URL}"
    info "pid $(echo "$pids" | tr '\n' ' ')"
    return 0
  elif [ -n "$pids" ]; then
    warn "a process holds port ${PORT} (pid $(echo "$pids" | tr '\n' ' ')) but isn't answering HTTP yet"
    return 1
  else
    info "not running (port ${PORT} is free)"
    return 1
  fi
}

case "${1:-restart}" in
  restart|"") do_stop && do_start ;;
  start)      do_start ;;
  stop)       do_stop ;;
  status)     do_status ;;
  logs)       mkdir -p logs; touch "$LOG"; info "tailing ${LOG} (Ctrl-C to quit)"; tail -f "$LOG" ;;
  -h|--help|help)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    err "unknown command: $1"
    info "usage: ./restart.sh [restart|start|stop|status|logs]"
    exit 1
    ;;
esac
