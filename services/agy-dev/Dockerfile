# syntax=docker/dockerfile:1.7
FROM node:20-slim

# ── Layer 1: minimal system deps ────────────────────────────────
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates bash expect python3 \
  && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Antigravity CLI (agy) — layer phụ thuộc network ─────
# NOTE: install.sh sets up `agy` binary at /root/.local/bin/agy
#
# 💡 Bump AGYCLI_CACHE_BUILD (trong .env) để force rebuild layer này và tải agy mới nhất.
#    Lưu ý: build chỉ lấy latest tại thời điểm build. Việc luôn chạy bản mới
#    nhất ở mỗi lần Docker start do entrypoint.sh đảm nhận (xem Layer 4).
ARG AGY_INSTALL_URL="https://antigravity.google/cli/install.sh"
ARG AGYCLI_CACHE_BUILD="2026-10-22"
ARG AGY_EXPECTED_VERSION=""
COPY agy-install.sh /tmp/agy-install.sh
RUN AGY_INSTALL_URL="${AGY_INSTALL_URL}" \
  AGYCLI_CACHE_BUILD="${AGYCLI_CACHE_BUILD}" \
  AGY_EXPECTED_VERSION="${AGY_EXPECTED_VERSION}" \
  bash /tmp/agy-install.sh

# ── Layer 3: wrapper script (đổi khi exec-wrapper.sh đổi) ───────
COPY exec-wrapper.sh /exec-wrapper.sh
COPY agy_oauth_flow.py /agy_oauth_flow.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /exec-wrapper.sh /agy_oauth_flow.py /entrypoint.sh

RUN mkdir -p /root/.gemini/antigravity-cli

# ── Runtime defaults inherited by every `docker exec` session ──────────────
# agy >= 1.1.19 env vars. Both exist so the PTY driver gets clean, complete
# text to scrape instead of banner art and dirty-rect redraw deltas:
#   AGY_CLI_HIDE_LOGO                          - suppress banner logo art
#   AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS - force full redraws
ENV AGY_CLI_HIDE_LOGO=1 \
    AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS=1

WORKDIR /app

# ── Layer 4: luôn chạy agy mới nhất khi container start ────────
# entrypoint kiểm tra manifest upstream và tự nâng cấp agy trước khi exec CMD.
# Nếu mạng lỗi / manifest không đọc được → vẫn chạy binary có trong image.
ENTRYPOINT ["/entrypoint.sh"]

# Keep container alive (stdin_open + tty are set in docker-compose)
CMD ["tail", "-f", "/dev/null"]