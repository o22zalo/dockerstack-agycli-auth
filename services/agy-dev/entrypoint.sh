#!/usr/bin/env bash
# entrypoint.sh — agy-dev container entrypoint.
#
# Mục tiêu: mỗi lần container start đều chạy `agy` bản MỚI NHẤT.
#
# Cách làm:
#   1) Hỏi manifest chính thức của Antigravity CLI để biết version latest.
#   2) So với version `agy --version` đang có trong image/container.
#   3) Nếu khác → tải & cài bản latest vào thư mục tạm, verify rồi mới
#      hoán đổi nguyên tử (atomic mv) vào /root/.local/bin/agy. Bản cũ được
#      giữ nguyên nếu tải/cài lỗi → container vẫn start bình thường.
#   4) Tuỳ chọn: kiểm tra lại định kỳ trong lúc chạy (AGY_UPDATE_INTERVAL_SEC).
#
# Lý do cần entrypoint: image build chỉ lấy latest tại thời điểm build, còn
# agy phát hành bản mới liên tục. Docker restart/recreate không rebuild image
# nên nếu không có bước này, container sẽ chạy bản cũ đóng băng trong layer.
#
# Env:
#   AGY_AUTO_UPDATE            1 = bật (default), 0 = tắt (dùng binary trong image)
#   AGY_MANIFEST_BASE_URL      base URL chứa /manifests/<platform>.json
#   AGY_UPDATE_INTERVAL_SEC    >0 = kiểm tra lại mỗi N giây (default 0 = chỉ lúc start)
#   AGY_UPDATE_URL             URL install.sh chính thức
#   AGY_BIN_DIR                thư mục cài binary (default /root/.local/bin)

set -u

export PATH="/root/.local/bin:/usr/local/bin:${PATH}"

AGY_AUTO_UPDATE="${AGY_AUTO_UPDATE:-1}"
AGY_MANIFEST_BASE_URL="${AGY_MANIFEST_BASE_URL:-https://antigravity-cli-auto-updater-974169037036.us-central1.run.app}"
AGY_UPDATE_INTERVAL_SEC="${AGY_UPDATE_INTERVAL_SEC:-0}"
AGY_UPDATE_URL="${AGY_UPDATE_URL:-https://antigravity.google/cli/install.sh}"
AGY_BIN_DIR="${AGY_BIN_DIR:-/root/.local/bin}"

log() { printf '[agy-entrypoint] %s\n' "$*"; }

# ─── platform key theo manifest upstream ─────────────────────────────────────
detect_platform() {
  local machine
  machine="$(uname -m)"
  case "${machine}" in
    x86_64 | amd64) printf 'linux_amd64' ;;
    aarch64 | arm64) printf 'linux_arm64' ;;
    *) printf '' ;;
  esac
}

# ─── version helpers ────────────────────────────────────────────────────────
extract_version() {
  printf '%s' "$1" \
    | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?' \
    | head -n 1 | sed 's/^v//' || true
}

current_version() {
  local out
  out="$(agy --version 2>/dev/null || true)"
  extract_version "$out"
}

latest_version() {
  local platform json
  platform="$(detect_platform)"
  if [ -z "${platform}" ]; then
    log "WARN: kiến trúc $(uname -m) không có trong manifest upstream."
    return 1
  fi
  json="$(curl -fsSL --connect-timeout 10 --max-time 25 \
    "${AGY_MANIFEST_BASE_URL}/manifests/${platform}.json" 2>/dev/null)" || return 1
  [ -n "${json}" ] || return 1
  printf '%s' "${json}" \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

# ─── update: tải vào staging rồi hoán đổi atomic ────────────────────────────
update_to_latest() {
  local want="$1"
  local staging="/tmp/agy-update"
  local upstream="/tmp/_agy-upstream-install.sh"
  local fake_home="${staging}/home"
  local installed

  rm -rf "${staging}"
  mkdir -p "${staging}" "${fake_home}"

  if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 \
    "${AGY_UPDATE_URL}" -o "${upstream}"; then
    log "WARN: không tải được install.sh từ ${AGY_UPDATE_URL}."
    rm -rf "${staging}"
    return 1
  fi

  # install.sh từ chối cài nếu binary đã tồn tại → cài vào --dir tạm.
  # HOME giả để `agy install` không ghi PATH vào profile thật của container
  # (/root/.bashrc, .profile, .zshrc) mỗi lần update.
  if ! HOME="${fake_home}" bash "${upstream}" --dir "${staging}"; then
    log "WARN: install.sh trả về lỗi khi cài vào staging."
    rm -f "${upstream}"
    rm -rf "${staging}"
    return 1
  fi
  rm -f "${upstream}"

  if [ ! -x "${staging}/agy" ]; then
    log "WARN: install.sh xong nhưng không thấy binary trong staging."
    rm -rf "${staging}"
    return 1
  fi

  installed="$(HOME="${fake_home}" "${staging}/agy" --version 2>/dev/null || true)"
  installed="$(extract_version "${installed}")"
  if [ -n "${want}" ] && [ "${installed}" != "${want}" ]; then
    log "WARN: binary mới báo version '${installed:-unknown}', manifest '${want}' — vẫn dùng binary mới."
  fi

  mkdir -p "${AGY_BIN_DIR}"
  if ! mv -f "${staging}/agy" "${AGY_BIN_DIR}/agy.new"; then
    log "WARN: không ghi được ${AGY_BIN_DIR}/agy.new."
    rm -rf "${staging}"
    return 1
  fi
  chmod +x "${AGY_BIN_DIR}/agy.new" || true
  if ! mv -f "${AGY_BIN_DIR}/agy.new" "${AGY_BIN_DIR}/agy"; then
    log "WARN: không hoán đổi được binary mới vào ${AGY_BIN_DIR}/agy."
    rm -rf "${staging}"
    return 1
  fi

  rm -rf "${staging}"
  hash -r 2>/dev/null || true
  return 0
}

ensure_latest_agy() {
  local cur want
  cur="$(current_version)"
  if ! want="$(latest_version)"; then
    log "Không đọc được manifest upstream — giữ nguyên agy ${cur:-unknown}."
    return 0
  fi

  log "agy hiện tại: ${cur:-none} | latest upstream: ${want}"

  if [ "${cur}" = "${want}" ]; then
    log "agy đã là bản mới nhất (${cur})."
    return 0
  fi

  log "Đang nâng cấp agy ${cur:-none} → ${want} ..."
  if update_to_latest "${want}"; then
    cur="$(current_version)"
    if [ "${cur}" = "${want}" ]; then
      log "agy đã cập nhật: ${cur} ($(command -v agy))"
    else
      log "WARN: sau cập nhật agy báo '${cur:-unknown}' (mong đợi '${want}')."
    fi
  else
    log "WARN: tự động cập nhật thất bại — tiếp tục với agy ${cur:-unknown}."
  fi
}

if [ "${AGY_AUTO_UPDATE}" = "1" ]; then
  ensure_latest_agy
  if [ "${AGY_UPDATE_INTERVAL_SEC}" -gt 0 ] 2>/dev/null; then
    (
      while sleep "${AGY_UPDATE_INTERVAL_SEC}"; do
        ensure_latest_agy
      done
    ) &
  fi
else
  log "AGY_AUTO_UPDATE=0 — bỏ qua kiểm tra version, dùng agy có sẵn trong image."
fi

exec "$@"
