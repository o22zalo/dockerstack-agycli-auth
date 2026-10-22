# RESEARCH & LOG — tối ưu lệnh `agy` để lấy 2 URL auth KHÔNG cần thao tác TUI

> **LƯU Ý — TÀI LIỆU LỊCH SỬ (2026-09-29).** Thư mục này KHÔNG được nối vào
> stack: không có Dockerfile, không có service trong compose, không script nào
> gọi tới. Nó là công cụ nghiên cứu chạy tay trên máy local.
>
> Mọi thông số dưới đây được kiểm chứng trên **agy v1.1.11**. Stack production
> hiện chạy **agy v1.2.12**, và các thay đổi sau đã làm một số kết luận ở đây
> không còn đúng — đặc biệt:
>
> - **1.2.6/1.2.10:** headless lỗi giờ in `AGY_ERROR: {...}` ra stderr và **exit 3**
>   (trước là exit 1), nên kết luận "exit code 1 = lỗi" ở mục 4 không còn áp dụng.
> - **1.1.28:** `--print-timeout` hết hạn trả **partial output** và **exit 0**, nên
>   kết luận "exit 0 = probe thành công" ở mục 4 là sai.
> - **1.2.6:** timeout headless mặc định đổi từ 5 phút sang **không giới hạn**.
> - Driver production (`services/agy-dev/agy_oauth_flow.py`) đã được vá đầy đủ cho
>   các thay đổi này — xem bảng ánh xạ trong `docs/AGY_AUTH_VERIFY_RESEARCH.md`.
>
> **Đừng dùng script này làm nguồn sự thật cho logic production.** Hãy dùng
> `services/agy-dev/agy_oauth_flow.py`.

File này ghi lại toàn bộ quá trình nghiên cứu (nguồn web, thử nghiệm trên máy,
kết luận từng bước) giống như log của phiên làm việc, kèm đường dẫn rõ ràng.
Mọi thông số kiểm chứng trên **agy v1.1.11** (Linux, không D-Bus, TZ=UTC).

---

## 1. Vấn đề gốc

Script `agy_oauth_flow.py` phiên bản đầu phải **điều khiển TUI** `agy -i` bằng
phím bấm qua PTY để có 2 URL:

1. **OAuth URL** — `https://accounts.google.com/o/oauth2/auth?...`
2. **Verify URL** — `https://accounts.google.com/v3/signin/continue?...` (agy 1.4.x; 1.2.x: `/signin/continue?...`)

Thao tác TUI gồm: trả lời terminal capability query (DECRQM 2026/2027, DA, DSR),
chọn menu `1. Google OAuth`, onboarding (color scheme → ToS → trust), submit
prompt. Mong muốn: **bỏ hết TUI**, chỉ còn tối đa một bước thủ công là dán code.

---

## 2. Ground truth trên máy (trước khi tối ưu)

| Kiểm tra | Kết quả | Ghi chú |
|---|---|---|
| `agy --version` | `1.1.11` | binary ELF đơn (`~/.local/bin/agy`), không phải wrapper |
| `agy --help` | Không có subcommand `auth` | `agy auth login` chưa tồn tại ở v1.1.11 (có ở bản khác, xem issue #43) |
| `~/.gemini/antigravity-cli/` | `settings.json`, `cache/onboarding.json`, `antigravity-oauth-token`, `jetski_state.pbtxt`, `log/cli-*.log` | đây là nơi lưu state chứ không phải `~/.antigravity/` |
| `cache/onboarding.json` | `{"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":false,"onboardingComplete":true}` | preseed được → bỏ onboarding |
| `settings.json` | `{"trustedWorkspaces": ["/workspaces/git-mirror"]}` | preseed được → bỏ trust prompt |
| `jetski_state.pbtxt` | `post_onboarding` đầy đủ | đồng bộ với onboarding.json |

Kết luận: **có thể preseed state để AGY không hỏi onboarding/trust** → bỏ được 2
loại thao tác TUI. Còn lại: chọn login method + submit prompt.

---

## 3. Tìm kiếm web (diễn đàn / GitHub / Reddit / docs)

### 3.1. Nguồn chính

- Repo: `https://github.com/google-antigravity/antigravity-cli` — AGY (Antigravity
  CLI) thay thế Gemini CLI từ 18/06/2026; TUI Go, auth qua keyring → Google Sign-In.
- Docs headless: `https://antigravity.google/docs/cli/headless` — `-p/--print`
  chạy 1 prompt, stdout = response, **stderr = diagnostics/auth prompts/progress**;
  không-TTY + chưa auth → thoát lỗi `authentication required` (không treo).
- Releases: hỗ trợ dán code trong print mode qua **controlling terminal**
  (`/dev/tty` POSIX, `CONIN$` Windows) khi stdin bị chiếm bởi prompt pipe;
  run "truly headless" fail-fast.
- `auth-internals.md` + `scripts/agy_auth_broker.py`
  (`https://github.com/oaustegard/claude-skills/.../invoking-antigravity/`):
  - `agy -p` thiếu token → in OAuth URL, chờ code **~30s** (bản 1.0.0) rồi abort;
    `--print-timeout` chỉ ảnh hưởng chờ response.
  - `agy -i` không có auth timeout → lý do broker cũ điều khiển `-i`.
  - TUI cần trả lời DECRQM/DA/DSR mới render; pipe thường không trả lời → treo.
  - AGY chuyển **file-based token storage** khi phát hiện SSH session
    (`SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`) → token tại
    `~/.gemini/antigravity-cli/antigravity-oauth-token`; `refresh_token` là
    credential bền — copy/plant file này để tái sử dụng login.
- Issue #78 (`GEMINI_API_KEY` regression): AGY **không** hỗ trợ API key;
  đã dùng OAuth là bắt buộc (với AGY bản 1.x).
- Issue #53: keyring headless fail → dùng `GEMINI_FORCE_FILE_STORAGE=true` +
  `TZ=UTC` (tránh bug timezone offset của FileKeychain).
- Issue #43: URL bị hard-wrap trong `agy auth login` (fixed từ 1.0.12) → vẫn nên
  dùng PTY rộng 2000 cột cho an toàn.
- Issue #76 / #318: `agy -p` non-TTY có thể **nuốt stdout** (exit 0, output rỗng);
  workaround phổ biến: chạy trong PTY (`script -qec ...`).
- PR gemini-cli #3713 / #4475 (`NO_BROWSER`): cơ chế offline OAuth gốc của
  gemini-cli; AGY tự nhận headless/SSH và in URL.
- Codelab: `https://codelabs.developers.google.com/antigravity-cli-hands-on` —
  flow login + trust folder; cheatsheet `scriptbyai.com/antigravity-cli-cheatsheet`
  xác nhận "OAuth codes can also be pasted in print mode when a terminal is attached".

### 3.2. Cờ/env quan trọng thu được

```
agy -p "prompt"            # print mode, không TUI
agy --print-timeout 90s    # chờ response (KHÔNG phải auth-wait)
agy --log-file PATH        # log chứa nguyên văn validation_url
agy --dangerously-skip-permissions   # auto-approve mọi tool (tương đương --yolo)
GEMINI_FORCE_FILE_STORAGE=true       # ép lưu token dạng file
SSH_CONNECTION/SSH_CLIENT/SSH_TTY    # đánh dấu SSH → file-based storage
TZ=UTC                               # tránh bug timezone FileKeychain
preseed cache/onboarding.json        # bỏ onboarding
preseed settings.json trustedWorkspaces  # bỏ trust prompt
```

---

## 4. Thử nghiệm trên máy (từng bước)

### TN1 — `agy -p` thuần non-TTY (TERM=dumb, HOME sạch)
```bash
(sleep 18; echo BOGUS; sleep 3) | timeout 40 env HOME=/tmp/opencode/fh1 TERM=dumb \
  agy -p "Reply with OK" --log-file /tmp/opencode/fh1/cli.log >so.txt 2>se.txt
```
Kết quả (`se.txt`):
```
Error: authentication required. Run 'agy' to log in, then retry.
Error: authentication failed or timed out
```
Kết luận: **không-TTY → fail-fast, KHÔNG in URL**. Cần PTY.

### TN2 — `agy -p` dưới PTY (`script`), code giả, HOME sạch
```bash
(sleep 15; echo BOGUS_AUTH_CODE_123; sleep 3) | timeout 45 \
  script -qec "env HOME=/tmp/opencode/fh2 TERM=xterm-256color COLUMNS=2000 \
  agy -p 'Reply with OK' --log-file /tmp/opencode/fh2/cli.log" /tmp/opencode/fh2/ptyout.txt
```
Kết quả (PTY output):
```
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=...&state=...
Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:
BOGUS_AUTH_CODE_123
Error: authentication failed: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."
Error: authentication failed or timed out
```
Kết luận:
- **Print mode in OAuth URL plain-text, không cần TUI, không cần trả lời capability query.**
- Chờ code **60s** (bản 1.1.11), đọc code từ **stdin** (PTY) → chỉ cần dán code.
- Auth timeout 60s không cấu hình được → nếu chậm thì chạy lại (URL mới).

### TN3 — `agy -p` với HOME có sẵn token (đã login)
Copy `antigravity-oauth-token` + `cache/onboarding.json` + `settings.json` vào
`/tmp/opencode/fh3`, chạy:
```bash
timeout 70 script -qec "env HOME=/tmp/opencode/fh3 TERM=xterm-256color COLUMNS=2000 \
  agy -p 'Reply with OK' --print-timeout 45s --log-file /tmp/opencode/fh3/cli.log" /dev/null
```
Kết quả: `OK`, exit 0 — **headless hoàn toàn, không auth prompt, không TUI.**
Log xác nhận: `token_storage.go:123 Using file-based token storage because no
D-Bus session bus detected`, `printmode.go:429 not authenticated, trying silent
auth`, `printmode.go:431 silent auth succeeded`.

### TN4 — Phân tích log thật (phiên TUI trước đó)
`~/.gemini/antigravity-cli/log/cli-20260808_093220.log`:
```
http_helpers.go:325 Failed to make code assist backend request
  (https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary): {
    "error": { "code": 403, "status": "PERMISSION_DENIED",
      "message": "Verify your account to continue.",
      "details": [ { "@type": ".../google.rpc.ErrorInfo", "reason": "VALIDATION_REQUIRED",
        "metadata": { "validation_url": "https://accounts.google.com/signin/continue?...",
                      "validation_url_link_text": "Verify your account", ... } } ] } }
server_oauth.go:95 Account ineligible: Your current account is not eligible for Antigravity.
  Verify your account to continue.
```
Kết luận:
- **URL #2 nằm trong `--log-file` nguyên văn** (`metadata.validation_url`) — nguồn chắc chắn.
- Trigger là check quota `retrieveUserQuotaSummary` chạy ngay sau login (print mode
  cũng chạy — xác nhận ở TN3: `quota_manager.go:44 doRefreshQuota: starting reload`).
- OAuth URL (URL #1) **không** xuất hiện trong log — chỉ có trên output/PTY.

---

## 5. Thiết kế script mới (`agy_oauth_flow.py` — print mode)

| Thành phần | Cách làm |
|---|---|
| Spawn | `pty.fork()` chạy `agy -p "<prompt>" --print-timeout <d> --log-file <path>`; PTY rộng `2000x60` |
| HOME | temp mới mỗi lần (`--home` để tái sử dụng) + preseed onboarding.json/settings.json |
| Env | `SSH_*`, `GEMINI_FORCE_FILE_STORAGE=true`, `TZ=UTC`, `TERM=xterm-256color` |
| URL #1 | regex `accounts.google.com/o/oauth2/auth` trên PTY output |
| Code | chờ chuỗi `paste the authorization code` / `waiting for authentication` → đọc `--code-file` hoặc console → gửi `code+\r` |
| URL #2 | `is_verify_url()`: mọi URL `accounts.google.com` trừ `/o/oauth2/` — phủ `signin/continue`, `/v3/signin/continue` (1.4.x), `speedbump`, `accountappeals`; áp cho PTY output **và** tail `--log-file` |
| Token | copy `antigravity-oauth-token` ra outdir khi login thành công |
| Exit | `0` nếu có URL #1; `1` nếu không (đã login sẵn) |

Đã test: TN-fresh (code giả) → bắt URL #1 + phát hiện `token exchange failed`,
exit 0; TN-already (`--home` có token) → chạy prompt "OK", exit 1 đúng mong đợi.

Cấu trúc thư mục:
```
agy-auth/
├── agy_oauth_flow.py   # script print-mode (không TUI)
├── RESEARCH.md         # file này — log nghiên cứu + thinking
└── README.md           # hướng dẫn sử dụng
```

---

## 6. Việc còn lại / giới hạn

- E2E login **code thật** (tài khoản hiện tại đã eligible → xác nhận token file
  được tạo, không ra URL #2 — đúng).
- URL #2 với **tài khoản chưa verify** chỉ test được khi có account mới; cơ chế
  bắt từ `--log-file` đã được chứng minh bằng log thật (TN4).
- Bỏ hoàn toàn được thao tác TUI; bước thủ công duy nhất còn lại là **mở OAuth URL
  và dán code** (bản chất PKCE của OAuth).
