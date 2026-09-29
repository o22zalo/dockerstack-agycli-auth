#!/usr/bin/env bash
# agy-install.sh — Tải và cài Antigravity CLI (agy)
# Biến đầu vào (truyền qua env):
#   AGY_INSTALL_URL  — URL của install.sh (default: https://antigravity.google/cli/install.sh)
#   AGYCLI_CACHE_BUILD   — Dùng để bust Docker cache, không ảnh hưởng logic cài đặt
#   AGY_EXPECTED_VERSION — Optional guard; fail build if installed version does not match
set -eu

AGY_INSTALL_URL="${AGY_INSTALL_URL:-https://antigravity.google/cli/install.sh}"
AGY_EXPECTED_VERSION="${AGY_EXPECTED_VERSION:-}"
export PATH="/root/.local/bin:/usr/local/bin:${PATH}"

echo "==> [agy-install] cache bust: ${AGYCLI_CACHE_BUILD:-unset}"
echo "==> [agy-install] source: ${AGY_INSTALL_URL}"

# 1. Download install.sh với retry
downloaded=0
for attempt in 1 2 3; do
  echo "==> [agy-install] download attempt ${attempt}/3..."
  if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 \
      "${AGY_INSTALL_URL}" -o /tmp/_agy-upstream-install.sh; then
    downloaded=1
    break
  fi
  echo "==> [agy-install] attempt ${attempt} failed, retrying..." >&2
  sleep 3
done

if [ "${downloaded}" != "1" ]; then
  echo "[agy-install] FAILED: Tai install.sh that bai sau 3 lan thu." >&2
  exit 1
fi

# 2. Chạy install.sh
# install.sh có thể exit non-zero do warning PATH dù cài thành công, nên ta KHÔNG
# hard-fail ngay ở bước này — nhưng cũng KHÔNG nuốt lỗi bằng `|| true`: ghi nhận
# exit code để log cảnh báo rõ ràng. Nguồn sự thật là verify binary + version
# (optional guard) bên dưới → install hỏng = fail build, không lặp lại bug
# "silently-swallowed install failure" của 2.1.0.
set +e
bash /tmp/_agy-upstream-install.sh
install_rc=$?
set -e
rm -f /tmp/_agy-upstream-install.sh

if [ "${install_rc}" -ne 0 ]; then
  echo "==> [agy-install] WARNING: install.sh exited ${install_rc} (có thể do PATH warning). Sẽ verify binary/version bên dưới." >&2
fi

# 3. Verify binary + version — fail loudly nếu cài hỏng thật sự
if ! command -v agy >/dev/null 2>&1; then
  echo "[agy-install] FAILED: install.sh chay xong nhung KHONG tim thay binary agy trong PATH." >&2
  echo "  PATH=${PATH}" >&2
  echo "  install_rc=${install_rc}" >&2
  ls -la /usr/local/bin /root/.local/bin 2>/dev/null || true
  exit 1
fi

if ! AGY_VERSION="$(agy --version 2>&1)"; then
  echo "[agy-install] FAILED: agy binary exists but 'agy --version' cannot execute." >&2
  exit 1
fi
AGY_VERSION="$(printf '%s' "$AGY_VERSION" | head -n 1 | tr -d '\r')"

if [ -n "$AGY_EXPECTED_VERSION" ]; then
  # So khớp CHÍNH XÁC trên token version đầu tiên trong output, thay vì
  # substring. Lý do: so khớp chuỗi khiến pin "1.2.1" cũng match "1.2.10",
  # "1.2.11" và "1.2.12" — guard trở nên vô dụng đúng lúc ta cần nó nhất.
  # `agy --version` có thể in nhiều dòng (vd "agy 1.2.12 (build ...)") nên ta
  # lấy token version đầu tiên. Tiền tố "v" bị bỏ ở cả hai vế vì
  # validate-env.js chấp nhận cả "1.2.12" lẫn "v1.2.12".
  extract_version() {
    printf '%s' "$1" \
      | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?' \
      | head -n 1 | sed 's/^v//' || true
  }
  AGY_VERSION_TOKEN="$(extract_version "$AGY_VERSION")"
  AGY_EXPECTED_TOKEN="$(extract_version "$AGY_EXPECTED_VERSION")"

  if [ -z "$AGY_EXPECTED_TOKEN" ]; then
    echo "[agy-install] FAILED: AGY_EXPECTED_VERSION='$AGY_EXPECTED_VERSION' is not a full x.y.z version." >&2
    echo "[agy-install] Pin all three components (e.g. 1.2.12), never a prefix." >&2
    exit 1
  fi

  if [ -z "$AGY_VERSION_TOKEN" ]; then
    # Không tìm thấy version trong output: KHÔNG đoán. Fail build.
    echo "[agy-install] FAILED: could not parse a version out of 'agy --version' output: '$AGY_VERSION'." >&2
    echo "[agy-install] Refusing to guess; expected '$AGY_EXPECTED_TOKEN'." >&2
    exit 1
  fi

  if [ "$AGY_VERSION_TOKEN" != "$AGY_EXPECTED_TOKEN" ]; then
    echo "[agy-install] FAILED: installed version '$AGY_VERSION_TOKEN' does not match AGY_EXPECTED_VERSION='$AGY_EXPECTED_TOKEN'." >&2
    echo "[agy-install] This guard prevents an untested upstream auto-update from entering the stable stack." >&2
    exit 1
  fi
  AGY_VERSION="$AGY_VERSION_TOKEN"
fi

echo "==> [agy-install] OK: agy ${AGY_VERSION} at $(command -v agy)"
