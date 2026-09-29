#!/usr/bin/env bash
# ================================================================
#  dc.sh — Docker Compose Orchestrator
#  Reads .env feature flags → auto-selects profiles → runs compose
#
#  Usage:
#    bash docker-compose/scripts/dc.sh up -d --build
#    bash docker-compose/scripts/dc.sh down
#    bash docker-compose/scripts/dc.sh logs -f
#    bash docker-compose/scripts/dc.sh ps
#    bash docker-compose/scripts/dc.sh config
#    bash docker-compose/scripts/dc.sh <any compose command>
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

expand_env_refs() {
  local value="$1"
  local ref replacement
  while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    ref="${BASH_REMATCH[1]}"
    replacement="${!ref-}"
    value="${value//\$\{$ref\}/$replacement}"
  done
  printf '%s' "$value"
}

load_env_file() {
  local env_file="${1:-.env}"
  local line key value

  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$(trim "$line")" ] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [ "${#value}" -ge 2 ]; then
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi

    # Backward-compatible with legacy .env entries that escaped "$" as "$$".
    value="${value//\$\$/\$}"
    value="$(expand_env_refs "$value")"
    export "$key=$value"
  done < "$env_file"
}

resolve_host_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s' "$path"
  elif [[ "$path" =~ ^[A-Za-z]:[\\/].* ]]; then
    printf '%s' "$path"
  else
    path="${path#./}"
    printf '%s' "$ROOT_DIR/$path"
  fi
}

prepare_docker_volume_dirs() {
  local volume_root
  volume_root="$(resolve_host_path "${DOCKER_VOLUMES_ROOT:-./.docker-volumes}")"

  mkdir -p \
    "$volume_root/app/logs" \
    "$volume_root/app/data" \
    "$volume_root/tinyauth" \
    "$volume_root/caddy/data" \
    "$volume_root/caddy/config" \
    "$volume_root/filebrowser/database" \
    "$volume_root/tailscale/var-lib" \
    "$volume_root/deploy-code/logs" \
    "$volume_root/deploy-code/backups" \
    "$volume_root/deploy-code/tmp" \
    "$volume_root/rclone/cache"

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  DATA_ROOT : $volume_root"
  fi
}

# ── Load .env ─────────────────────────────────────────────────────
if [ -f "$ROOT_DIR/.env" ]; then
  load_env_file "$ROOT_DIR/.env"
else
  echo "⚠️  .env not found — using defaults. Run: cp .env.example .env" >&2
fi

# Normalize tags to comma-separated form without spaces.
if [ -n "${TAILSCALE_TAGS:-}" ]; then
  TAILSCALE_TAGS="$(printf '%s' "$TAILSCALE_TAGS" | tr -d '[:space:]')"
  export TAILSCALE_TAGS
fi

# Default deploy-code public hostname. Override in .env when a different
# Cloudflare/Caddy hostname is required.
if [ -z "${DOCKER_DEPLOY_CODE_CADDY_HOSTS:-}" ]; then
  DOCKER_DEPLOY_CODE_CADDY_HOSTS="deploy.${DOMAIN:-localhost}"
  export DOCKER_DEPLOY_CODE_CADDY_HOSTS
fi

should_render_tailscale_serve() {
  case "${1:-}" in
    ""|up|start|restart|create|run|config|pull)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

render_tailscale_serve_config() {
  local tailnet_domain app_port serve_dir serve_file serve_hostname
  tailnet_domain="$(trim "${TAILSCALE_TAILNET_DOMAIN:-}")"
  app_port="$(trim "${APP_PORT:-3000}")"
  serve_hostname="${PROJECT_NAME:-myapp}.${tailnet_domain}"

  if [ -z "$tailnet_domain" ] || [ "$tailnet_domain" = "-" ]; then
    echo "❌ ENABLE_TAILSCALE=true nhưng TAILSCALE_TAILNET_DOMAIN chưa có giá trị hợp lệ." >&2
    echo "   Chạy: npm run tailscale-init (hoặc điền TAILSCALE_TAILNET_DOMAIN trong .env)." >&2
    exit 1
  fi

  if ! [[ "$app_port" =~ ^[0-9]+$ ]] || [ "$app_port" -lt 1 ] || [ "$app_port" -gt 65535 ]; then
    echo "❌ APP_PORT không hợp lệ: $app_port" >&2
    exit 1
  fi

  serve_dir="$ROOT_DIR/tailscale"
  serve_file="$serve_dir/serve.json"
  mkdir -p "$serve_dir"
  cat > "$serve_file" <<EOF
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${serve_hostname}:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:80"
        }
      }
    }
  }
}
EOF

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  TS_SERVE  : $serve_file (${serve_hostname} -> 127.0.0.1:80)"
  fi
}

# ── Detect OS (uname-based, not RUNNER_OS) ─────────────────────
# Phải bắt được CẢ ba dạng chạy bash trên Windows:
#   1. WSL2        → uname -r chứa "microsoft"/"wsl"
#   2. Git Bash /  → uname -s = MINGW64_NT-*, uname -r KHÔNG chứa gì đặc biệt
#      MSYS2 / Cygwin
# Trước đây chỉ kiểm tra (1) và Darwin, nên Git Bash bị nhận nhầm là "linux":
#   - chọn profile webssh-linux / tailscale-linux thay vì bản -windows
#   - không tắt MSYS path conversion, nên docker.exe nhận các biến kiểu
#     /root/.gemini/... bị đổi thành C:/Program Files/Git/root/.gemini/...
UNAME_S="$(uname -s)"
UNAME_R="$(uname -r)"

if echo "$UNAME_R" | grep -qi "microsoft\|wsl"; then
  _OS="windows"
elif echo "$UNAME_S" | grep -qiE "MINGW|MSYS|CYGWIN|Windows_NT"; then
  _OS="windows"
elif [ "$UNAME_S" = "Darwin" ]; then
  _OS="macos"
else
  _OS="${CUR_OS:-linux}"
fi

# ── Tắt MSYS/Git-Bash path conversion khi chạy trên Windows ─────────────
# Git Bash (MSYS2) tự động đổi mọi đường dẫn POSIX trông giống "/foo/bar"
# thành đường dẫn Windows trước khi gọi chương trình Windows. `docker.exe`
# là chương trình Windows, nên các giá trị như
# AGYCLI_AUTH_AGY_CREDENTIAL_PATH=/root/.gemini/... bị biến thành
# C:/Program Files/Git/root/.gemini/... và truyền thẳng vào container.
# Hậu quả: credential được ghi đúng chỗ nhưng backend tìm nhầm đường dẫn,
# login luôn kết thúc bằng "Credential disappeared before final save".
# Set cả hai biến để không để sót biến thể nào của MSYS.
if [ "$_OS" = "windows" ]; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
  export MSYS2_ENV_CONV_EXCL='*'
fi

# ── Build --profile arguments from ENABLE_* flags ──────────────
PROFILE_ARGS=()

if [ "${ENABLE_DOZZLE:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile dozzle)
fi

if [ "${ENABLE_FILEBROWSER:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile filebrowser)
fi

if [ "${ENABLE_WEBSSH:-true}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile webssh-windows)
  else
    PROFILE_ARGS+=(--profile webssh-linux)
  fi
fi

if [ "${ENABLE_TAILSCALE:-false}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile tailscale-windows)
  else
    PROFILE_ARGS+=(--profile tailscale-linux)
  fi
fi

if [ "${ENABLE_LITESTREAM:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile litestream)
fi

if [ "${DOCKER_DEPLOY_CODE_ENABLED:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile deploy-code)
fi

if [ "${ENABLE_RCLONE:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile rclone)
fi

if [ "${ENABLE_TAILSCALE:-false}" = "true" ] && should_render_tailscale_serve "${1:-}"; then
  render_tailscale_serve_config
fi

prepare_docker_volume_dirs

# ── Compose file list ──────────────────────────────────────────
FILES=(
  -f "$ROOT_DIR/docker-compose/compose.core.yml"
  -f "$ROOT_DIR/docker-compose/compose.auth.yml"
  -f "$ROOT_DIR/docker-compose/compose.ops.yml"
  -f "$ROOT_DIR/docker-compose/compose.access.yml"
  -f "$ROOT_DIR/docker-compose/compose.deploy.yml"
  -f "$ROOT_DIR/docker-compose/compose.rclone.yml"
  -f "$ROOT_DIR/compose.apps.yml"
)

# Khi rclone bật, nạp thêm gate override để các service quan trọng
# depends_on rclone-restore (đảm bảo data có sẵn trước khi start).
if [ "${ENABLE_RCLONE:-false}" = "true" ]; then
  FILES+=( -f "$ROOT_DIR/docker-compose/compose.rclone-gate.yml" )
fi

# Khi litestream bật, nạp thêm gate override để app/tinyauth
# depends_on litestream-restore (restore DB trước khi start).
if [ "${ENABLE_LITESTREAM:-true}" = "true" ]; then
  FILES+=( -f "$ROOT_DIR/docker-compose/compose.litestream-gate.yml" )
fi

# ── Debug info (set DC_VERBOSE=1 to show) ─────────────────────
if [ "${DC_VERBOSE:-0}" = "1" ]; then
  echo "── dc.sh debug ──────────────────────────────────"
  echo "  OS        : $_OS"
  echo "  PROJECT   : ${PROJECT_NAME:-?}"
  echo "  DOMAIN    : ${DOMAIN:-?}"
  echo "  PROFILES  : ${PROFILE_ARGS[*]:-<none>}"
  echo "  FILES     : ${FILES[*]}"
  echo "─────────────────────────────────────────────────"
fi

# ── Execute ───────────────────────────────────────────────────
exec docker compose \
  "${FILES[@]}" \
  --project-directory "$ROOT_DIR" \
  --project-name "${PROJECT_NAME:-myapp}" \
  "${PROFILE_ARGS[@]}" \
  "$@"
