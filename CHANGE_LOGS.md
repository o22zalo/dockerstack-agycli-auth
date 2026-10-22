# CHANGE LOGS (Developer-facing)

---

## [2.4.1] — 2026-10-22 — Fix mất link verify (#2) trên agy 1.4.4

### Root cause

agy 1.4.4 đổi path của verification URL từ
`accounts.google.com/signin/continue?...` thành
`accounts.google.com/v3/signin/continue?plt=...&continue=...&sarp=1&scc=1&flowName=GlifWebSignIn`.
Driver và backend đều so khớp **nguyên chuỗi** `accounts.google.com/signin/continue`,
nên URL mới trượt hết: probe phân loại nhầm thành `eligibility_agent_error`
(dòng `error: Eligibility check failed: ... Verify your account to continue.`
nằm trên **stderr**) và UI không hiện được link verify. Đây chính là lý do
"lần 2" (sau khi login xong, bước verify cho account quota starter) không có link.

### Changed

- **`services/agy-dev/agy_oauth_flow.py`** — bỏ `VERIFY_HOST_PATH`, thêm
  `VERIFY_URL_RE` + `is_verify_url()`: nhận mọi URL `accounts.google.com`
  trừ OAuth authorize (`/o/oauth2/`), nên không vỡ khi AGY đổi `/v3/` hay path
  appeal. Dùng chung cho cả probe (`-p`) và vòng PTY login.
- Xét `INELIGIBLE_PATTERNS` **trước** nhánh `error:`/`AGY_ERROR` để tài khoản
  chưa verify không bị báo nhầm `eligibility_agent_error`.
- Khi AGY báo cần verify nhưng không match URL, emit
  `__AGY_FLOW_DETAIL__=verify_url_not_matched: <urls>` để lần sau đổi format
  còn lần ra nhanh.
- **`services/app/src/routes/login.js`** — `captureVerifyUrl()` dùng
  `isGoogleVerifyUrl()` (whitelist host, loại trừ `/o/oauth2/`) thay vì
  `includes('accounts.google.com/signin/continue')`.
- **`services/agy-verify/agy_oauth_flow.py`** (tool standalone) — `VERIFY_RE`
  cho phép prefix `vN` + `speedbump`/`accountappeals`; capture từ output và từ
  log tail đều dùng `is_verify_url()`.

### Verified

- `python3 -m py_compile` (2 file), `node --check services/app/src/routes/login.js` OK.
- Test driver với agy giả lập, URL đúng format 1.4.4 (`/v3/...`):
  emit `__AGY_VERIFY_URL__` và exit `10` (verification_required).
- URL format cũ 1.2.12 (không `/v3`) vẫn OK (exit `10`).
- Tài khoản ineligible **không** có link → `eligibility_failed_without_verify_url`.
- Unit test `is_verify_url()`: OAuth authorize → `False`; `/v3/signin/continue`,
  `/signin/continue`, `/accountappeals`, `/speedbump` → `True`.

### Note

Link verify do agy in ra kết thúc bằng `&authuser` (không có `=N`); giữ nguyên
đúng như agy in, không tự sửa URL official.

---

## [2.4.0] — 2026-10-22 — AGY 1.2.12 → 1.4.4 + luôn chạy bản mới nhất khi Docker start

### Changed — luôn latest thay vì pin cứng

- **`services/agy-dev/entrypoint.sh`** (mới) — entrypoint của container `agy-dev`.
  Mỗi lần container start: đọc manifest upstream
  (`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_<arch>.json`),
  so version với `agy --version`, lệch thì tải `install.sh` và cài vào staging
  (`--dir /tmp/agy-update` với `HOME` tạm), verify rồi `mv` nguyên tử vào
  `/root/.local/bin/agy`. Tải/cài lỗi → giữ binary cũ và container vẫn start.
  `AGY_UPDATE_INTERVAL_SEC > 0` bật kiểm tra định kỳ trong lúc chạy.
- **`services/agy-dev/Dockerfile`** — thêm `ENTRYPOINT ["/entrypoint.sh"]`,
  copy + chmod entrypoint, bump `AGYCLI_CACHE_BUILD` `2026-09-29` → `2026-10-22`.
- **`compose.apps.yml`** — truyền `AGY_AUTO_UPDATE`, `AGY_MANIFEST_BASE_URL`,
  `AGY_UPDATE_INTERVAL_SEC`, `AGY_UPDATE_URL` cho `agy-dev`; bump build-arg
  `AGYCLI_CACHE_BUILD`; healthcheck `start_period` `10s` → `180s` (entrypoint có
  thể phải tải ~30MB nén trước khi exec CMD).
- **`AGYCLI_AUTH_AGY_EXPECTED_VERSION`** để trống trong `.env` / `.env.example`.
  Giữ pin `1.2.12` sẽ làm build FAIL ngay khi upstream lên 1.4.4.

### Verified

- `bash -n` OK cho `entrypoint.sh` và `agy-install.sh`.
- Chạy thật entrypoint trong WSL với manifest upstream: cài 1.4.4, `agy --version`
  → `1.4.4`; chạy lần 2 nhận "đã là bản mới nhất", không tải lại.
- Manifest không truy cập được → giữ version hiện có, container vẫn start.
- `AGY_AUTO_UPDATE=0` → bỏ qua kiểm tra, dùng binary trong image.
- `agy 1.4.4 --help` vẫn còn `-p/--print` và `--print-timeout` mà
  `agy_oauth_flow.py` dùng.



### Changed — version pin and cache invalidation

- **`AGYCLI_CACHE_BUILD`** bumped `2026-06-10` → `2026-09-29` in all four places
  that carry a default: `.env`, `.env.example`, `compose.apps.yml`, and
  `services/agy-dev/Dockerfile`. The upstream installer has no version flag and
  always installs the current `latest`, so this argument is the only thing that
  forces a fresh download; leaving any one of the four stale keeps the old layer.
- **`AGYCLI_AUTH_AGY_EXPECTED_VERSION`** is now set to `1.2.12` in `.env` and
  `.env.example`. The guard previously existed but was empty in `.env.example` and
  absent from `.env` entirely, so nothing was actually enforced. The guard was also
  a bare substring match, so a partial pin such as `1.2.1` would have silently
  accepted `1.2.10`–`1.2.12`; it now compares the first version token exactly.
- **`AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC`** raised `45` → `90` in `.env`,
  `.env.example`, and the `compose.apps.yml` default.

### Fixed — eligibility probe misclassified real AGY failures

Upstream changes between the previously documented 1.1.11 and 1.2.12 broke outcome
classification in `services/agy-dev/agy_oauth_flow.py`. Details and the per-change
mapping table are in `docs/AGY_AUTH_VERIFY_RESEARCH.md`.

- **agy 1.2.6 / 1.2.10** — headless agent and model failures now print an
  `AGY_ERROR: {...}` JSON line on stderr and exit with code `3`. The probe only
  scanned stdout text, so every one of these failures was reported as
  `eligibility_inconclusive_no_probe_response`. Added `classify_agy_error()`,
  `http_status_from_agy_error()`, a `returncode` check, and a new
  `eligibility_agent_error` reason. HTTP statuses inside the payload are now
  classified too, so a 403/429/5xx is still reported as `eligibility_network_error`
  and a 401 as `credential_missing_or_expired` rather than as an agent error.
- **agy 1.1.28** — when `--print-timeout` expires, AGY now returns *partial* output
  and exits `0` with a stderr warning instead of failing. A truncated probe whose
  partial text happened to contain the nonce was therefore accepted as `verified`.
  Truncation markers are now checked before nonce matching, and the new
  `eligibility_probe_truncated` reason is reported.
- **agy 1.2.9** — headless runs wait for background tasks until the
  `--print-timeout` deadline. The old `verify_wait + 30s` budget was too tight and
  widened to `max(90, verify_wait + 60)`.
- **agy 1.2.5** — a credential the sign-in server definitively rejects is now
  cleared automatically, which was indistinguishable from a missing credential and
  made the UI tell users to log in again for nothing. Added the non-retryable
  `credential_stale_signed_out` reason with deliberately specific match patterns.
- **agy 1.1.23** — prompts entered right after login are queued until background
  eligibility verification finishes, so the 10s grace window after code submission
  could abandon the TUI mid-verification. Raised to 30s.
- **agy 1.1.19** — set the new `AGY_CLI_HIDE_LOGO` and
  `AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS` variables in the image and in both
  child environments, so scraped text is not polluted by banner art or renderer
  dirty-rect deltas.

### Added — diagnostics and documentation

- New `__AGY_FLOW_DETAIL__` marker carries the AGY exit code and decoded
  `AGY_ERROR` fields into the auth log. It is diagnostic only and never changes
  session state; `MARKER_RE` in `services/app/src/routes/login.js` was widened to
  accept it, and `errorMessageForReason` now covers the three new reasons.
- `docs/AGY_AUTH_VERIFY_RESEARCH.md` gained the 1.1.8 → 1.2.12 delta, the
  guard's substring and runtime-drift caveats, an error-reason table, and two
  operational notes about cache invalidation and re-validating before a pin. It
  also records the three places where the real 1.2.12 binary contradicts the
  changelog.

### Fixed — `error:` marker detection, after measuring the real binary

Running the driver against a real 1.2.12 binary (not just the changelog) found
three things worth recording, all captured in
`docs/AGY_AUTH_VERIFY_RESEARCH.md`:

- agy 1.2.12 **still** prints the `ERROR: logging before google.Init` prefix that
  1.2.0 claimed to have removed. Matching a bare `error:` substring would therefore
  have misclassified ordinary runs as fatal errors. The `1.1.28` marker is now
  matched anchored to the start of a line, with that known prefix excluded.
- The actual marker text is `error: authentication failed or timed out`; it is now
  in the explicit pattern list.
- Authentication failure exits with code **1**, not 3. Only agent/model failures
  use 3, so the authentication checks must run before the generic non-zero-exit
  classification to avoid reporting a missing credential as an agent error.

### Fixed — stale documentation

- `services/agy-dev/exec-wrapper.sh` claimed the wrapper maps to AGY's
  non-interactive print mode. Only the eligibility probe uses print mode; login
  drives the full interactive TUI via `agy -i`, which is required for the PKCE code
  prompt. Docstring corrected.
- `services/agy-verify/` is a research tool validated against 1.1.11 and is not
  wired into the stack. Marked as historical rather than re-validated.

### Known limitation

`agy` self-updates during normal runs and the binary lives in the container's
writable layer (only `/root/.gemini` is a volume), so the build-time guard offers
no protection after boot. Only the container healthcheck and the per-login
`checkAgyBinary()` can observe a runtime drift.

---

## [2.2.0] — 2026-08-08 — AGY Eligibility / Verification URL #2

### Added — official second-step account verification flow

- **`services/agy-dev/agy_oauth_flow.py`** — real PTY driver that keeps the OAuth
  authorization code in the same PKCE session, automates AGY onboarding, captures
  OAuth URL #1 and AGY's official Google verification URL #2, and emits structured
  markers for the backend. It does not bypass eligibility.
- **Positive verification evidence** now requires a successful interactive probe
  response containing a per-run nonce. Merely not seeing URL #2 for N seconds is
  no longer considered verified.
- **`POST /api/login/verify-check`** — after the user completes URL #2 in the
  browser, re-runs AGY eligibility using the existing OAuth credential; no second
  OAuth/PKCE login is required.
- **UI verification state** — `verification_required`, `checking_verification`,
  `verified`, `eligibility_error`, and `eligibility_unknown`; URL #2 gets a dedicated
  Open button and “I verified — Check Again” action.
- **Token persistence gate** — Firebase save now happens only after the PTY driver
  reports verified; credential creation alone is not treated as success.
- **Failure classification** separates OAuth/PKCE failure, missing/expired
  credential, network/backend error, unsupported location, no verification URL,
  and inconclusive probe response.
- **Session reliability** — verification-required sessions get a separate 20-minute
  timeout; timeout cleanup releases the Docker login mutex and removes temporary
  auth handoff state, preventing a timed-out login from blocking all later logins.
- **SSE replay** returns current status + OAuth URL + verification URL to late or
  reconnected browsers, reducing fast-host race conditions.
- **Runtime diagnostics** logs the resolved AGY binary and its version at login
  start to make upstream regressions easier to correlate.
- **Optional upstream version guard** (`AGYCLI_AUTH_AGY_EXPECTED_VERSION`) can
  fail the image build when Google's installer returns an untested AGY version; the
  healthcheck now executes `agy --version` rather than only checking PATH presence.
- Docker image now installs `python3`; compose and `.env.example` expose
  `AGYCLI_AUTH_AGY_LOGIN_FLOW_TIMEOUT_SEC`,
  `AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC`, and
  `AGYCLI_AUTH_VERIFICATION_SESSION_TIMEOUT_MS`.

---

## [2.1.0] — 2026-06-10

### Fixed — Auth fails on Azure pipeline (works on GitHub Actions)

- **`services/agy-dev/Dockerfile`** — root cause of the Azure-only auth failures.
  The `agy` CLI install used `curl … | bash || true`; the `|| true` **silently
  swallowed install failures**, producing an image with **no working `agy`
  binary**. Combined with Azure's weekly-rotated local buildx cache, a single
  bad-network build poisoned the layer for the whole week → consistent Azure
  failures while GitHub's scoped `type=gha` cache rebuilt cleanly.
  Now: **retry up to 3×, no `|| true`, and verify `command -v agy` at
  build-time** → a broken install **fails the build loudly** instead of caching
  a silently-broken image. Install URL overridable via `--build-arg AGY_INSTALL_URL`.
- **`services/agy-dev/exec-wrapper.sh`** — when `agy` is missing, emit a clear
  `__AGY_BINARY_MISSING__` sentinel + exit 127 instead of `exec`-ing a
  non-existent path (which produced opaque errors). Default print-timeout
  raised `1s → 5s` (1s was too tight on cold Azure agents).
- **`services/app/src/services/dockerService.js`** — `authProbeTimeout` default
  `1s → 5s`; new configurable `urlWaitTimeoutMs` (env `AGY_URL_WAIT_TIMEOUT_MS`,
  default 60s); new `checkAgyBinary()` pre-flight that verifies `agy` resolves
  inside the container.
- **`services/app/src/routes/login.js`** — pre-flight `checkAgyBinary` before
  spawning; detects the `__AGY_BINARY_MISSING__` sentinel; the previously
  **hardcoded 30s** URL-wait is now configurable and, on timeout, **attaches a
  sanitized (token-redacted) tail of stdout/stderr** so the real cause is
  visible instead of just "No auth URL within 30s".
- **`compose.apps.yml`** — maps new `AGY_LOGIN_PRINT_TIMEOUT` /
  `AGY_URL_WAIT_TIMEOUT_MS` to `app`; adds an `agy-dev` healthcheck that fails
  if the `agy` binary is absent.
- Note: `DOTENVRTDB_URL` was **not** the cause — it is an Azure DevOps secret
  variable (works as designed); `urlExtract.js` regex left untouched.

### Added / Changed — rclone: per-service, per-path configuration

- **Multi-path config (indexed vars, 1A)** — `.env` now supports
  `RCLONE_PATH_<N>_LOCAL / _REMOTE / _MODE / _GATE` for N = 1..10.
  - **MODE per path (2A):** `restore | sync | both` — each path can pull-only,
    push-only, or both, independently.
  - **Per-path gate (3A):** `GATE=true` → app/litestream wait for that path's
    restore before starting; `GATE=false` → restored in the background, app
    starts immediately.
- **Backward compatible:** leaving all `RCLONE_PATH_*` empty falls back to the
  old single-path behavior using `RCLONE_REMOTE_TARGET` + `RCLONE_LOCAL_PATH`
  (mode=both, gate=true). Existing `.env` files keep working unchanged.
- **`services/rclone/lib.sh`** (new) — shared path-collection/mode helpers,
  read by all three rclone scripts. Reads both `STACK_RCLONE_*` (forwarded by
  compose) and plain `RCLONE_*`.
- **`services/rclone/init.sh`** — validates the remote of **every** configured
  path against the rclone.conf.
- **`services/rclone/restore.sh`** — loops over restore-capable paths; takes
  `--gated-only` / `--non-gated-only` filter so the same script serves both the
  blocking restore container and the background restore in the sidecar.
- **`services/rclone/sync.sh`** — first restores non-gated paths in the
  background (non-blocking), then continuously syncs all `sync|both` paths;
  per-path audit. Idles (no busy loop) if no path needs syncing.
- **`docker-compose/compose.rclone.yml`** — forwards indexed path vars (1..10)
  via YAML anchors under the `STACK_RCLONE_*` prefix (avoids rclone's
  auto-mapping of `RCLONE_*` env → CLI flags); `rclone-restore` now runs with
  `--gated-only`; `rclone-sync` also mounts `restore.sh` + `lib.sh`.
- **`compose.rclone-gate.yml`** unchanged — app/litestream gate on
  `rclone-restore`, which now only processes `GATE=true` paths (= per-path gate).
- **`.env.example`** — documented the multi-path block + the two new auth
  timing vars (`AGYCLI_AUTH_AGY_LOGIN_PRINT_TIMEOUT`,
  `AGYCLI_AUTH_AGY_URL_WAIT_TIMEOUT_MS`).

---

## [2.0.0] — 2026-04-09

### Breaking Changes

- `docker-compose.yml` split into 4 module files — must use `docker-compose/scripts/dc.sh` (or `-f docker-compose/compose.core.yml -f docker-compose/compose.ops.yml -f docker-compose/compose.access.yml -f compose.apps.yml`) instead of plain `docker compose`
- Env var renames: `DOMAIN` replaces individual `SUBDOMAIN_*` vars; `STACK_NAME` replaces `COMPOSE_PROJECT_NAME`; `PROJECT_NAME` is new (required)
- `TAILSCALE_CLIENT_SECRET` → `TAILSCALE_AUTHKEY` (standardised Tailscale env naming)
- `APP_PORT` now drives the app container port directly; `SUBDOMAIN_APP`, `SUBDOMAIN_DOZZLE`, etc. removed

### Added

- **`docker-compose/scripts/dc.sh`** — main orchestrator: loads `.env`, reads `ENABLE_*` flags, builds `--profile` args, calls all 4 compose files in one command
- **`docker-compose/compose.core.yml`** — caddy + cloudflared, network + volumes definition; always-on
- **`docker-compose/compose.ops.yml`** — dozzle, filebrowser, webssh, webssh-windows; all profile-gated
- **`docker-compose/compose.access.yml`** — tailscale-linux, tailscale-windows; profile-gated
- **`compose.apps.yml`** — parameterised app service (`APP_IMAGE` + `APP_PORT`)
- **`docker-compose/scripts/up.sh` / `docker-compose/scripts/down.sh` / `docker-compose/scripts/logs.sh`** — one-liner shortcuts wrapping `dc.sh`
- **`docker-compose/scripts/validate-env.js`** — checks required vars, format validation (bcrypt, domain, port), subdomain preview
- **`docker-compose/scripts/validate-ts.js`** — Tailscale auth key format check + optional expiry lookup via TS API
- **`docker-compose/scripts/validate-compose.js`** — runs `docker compose config` across all 4 files to catch YAML errors
- **`npm run dockerapp-validate:all`** — combined validation pipeline (env → compose → TS)
- **`docs/DEPLOY.md`** — full deployment guide with mermaid flow diagrams, use cases, security checklist
- Subdomain auto-convention: all routes derived from `${PROJECT_NAME}.${DOMAIN}` pattern
- `DC_VERBOSE=1` debug flag for `docker-compose/scripts/dc.sh`
- `HEALTH_PATH` env to customise healthcheck endpoint per image

### Changed

- Image versions pinned (caddy `2.9.1-alpine`, cloudflared `2025.1.0`, dozzle `v8.x`, filebrowser `v2.30.0`, tailscale `stable`)
- Caddy `CADDY_INGRESS_NETWORKS` now uses `${STACK_NAME}_net` (was `app_net`)
- Network name: `${STACK_NAME:-mystack}_net` (dynamic, avoids conflicts between stacks)
- GitHub Actions and Azure Pipelines updated to call `docker-compose/scripts/dc.sh up` instead of bare `docker compose up`
- `detect-os.sh` no longer writes `COMPOSE_PROFILES` (profiles now fully managed by `docker-compose/scripts/dc.sh`)
- `.env.example` fully rewritten to match new schema

### Removed

- Monolithic `docker-compose.yml` (replaced by 4 module files)
- `SUBDOMAIN_APP`, `SUBDOMAIN_DOZZLE`, `SUBDOMAIN_FILEBROWSER`, `SUBDOMAIN_WEBSSH` env vars
- `TAILSCALE_CLIENT_SECRET` (use `TAILSCALE_AUTHKEY`)
- Hardcoded `build: ./services/app` in compose (now `APP_IMAGE` param)
- `scripts/generate-cf-config.js` and the generated-config workflow (maintain `cloudflared/config.yml` manually)

---
