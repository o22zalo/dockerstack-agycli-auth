# agy-auth — lấy 2 URL auth của Antigravity CLI (`agy`) không cần TUI

Thư mục này chứa script bắt **2 URL quan trọng** mà `agy` sinh ra trong quá trình
Google OAuth, **không cần thao tác TUI** (không bấm phím, không chọn menu, không
điều hướng onboarding):

| # | URL | Khi nào xuất hiện |
|---|-----|--------------------|
| 1 | **OAuth authorization URL** — `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=...&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&...` | Khi chưa có token, `agy` in ra để login |
| 2 | **Eligibility / verify URL** — `https://accounts.google.com/v3/signin/continue?...` (agy 1.4.x; 1.2.x không có `/v3`) | Sau login, **chỉ khi Eligibility Check fail** (tài khoản chưa được verify) |

## Cách tiếp cận: print mode (`agy -p`) — KHÔNG phải TUI

Phiên bản đầu điều khiển TUI `agy -i` bằng phím bấm qua PTY (chọn menu login,
onboarding, chat input…). Sau khi nghiên cứu (`google-antigravity/antigravity-cli`,
docs `antigravity.google/docs/cli/headless`, Reddit/forum, log thực tế), đã tối ưu
thành **print mode** — đơn giản và chắc chắn hơn nhiều:

- `agy -p "<prompt>"` dưới một PTY thường (không cần trả lời capability query,
  không cần chọn `Google OAuth`, không cần onboarding) sẽ tự in:
  ```
  Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?...
  Waiting for authentication (timeout 60s)...
  Or, paste the authorization code here and press Enter:
  ```
- OAuth URL đọc được **dạng plain-text** từ output → URL #1.
- Code được **dán lại qua stdin của PTY** (một dòng + Enter).
- Sau khi login, AGY chạy check quota `retrieveUserQuotaSummary` → nếu tài khoản
  chưa eligible, backend trả `PERMISSION_DENIED (403) VALIDATION_REQUIRED` kèm
  `metadata.validation_url` → URL #2. Nguồn chắc chắn nhất là **`--log-file`**
  (AGY ghi nguyên văn), script vừa quét output vừa tail log file.

Thao tác thủ công còn lại duy nhất: **mở OAuth URL và dán code** (bản chất PKCE
của OAuth — không thể bỏ, trừ khi dùng browser automation + credential).

## Những flag / env var quan trọng (kết quả nghiên cứu)

| Flag / Env | Tác dụng |
|---|---|
| `agy -p / --print / --prompt "..."` | Chạy 1 prompt, in kết quả ra stdout, không có TUI |
| `--print-timeout <d>` | Chờ model tối đa (mặc định 5m). **KHÔNG** phải là auth-wait |
| `--log-file <path>` | Ghi log → chứa nguyên văn `validation_url` (URL #2) |
| `--dangerously-skip-permissions` | Auto-approve mọi tool permission (tương đương `--approve all` / `--yolo` của gemini-cli) |
| `GEMINI_FORCE_FILE_STORAGE=true` | Bắt AGY lưu token dạng **file** (không dùng keyring/D-Bus) |
| `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` | Đánh dấu session SSH → AGY dùng file-based token storage |
| `TZ=UTC` | Tránh lỗi timezone offset của FileKeychain (issue #53) |
| preseed `~/.gemini/antigravity-cli/cache/onboarding.json` | `{"onboardingComplete":true,...}` → bỏ toàn bộ onboarding (dùng khi cần `-i`) |
| preseed `settings.json` → `"trustedWorkspaces"` | Bỏ prompt "Do you trust the contents?" |
| `ANTIGRAVITY_TOKEN` (CI) | Chưa có flag/API-key thay thế OAuth; `GEMINI_API_KEY` **không** được AGY hỗ trợ (issue #78) |

## Files

```
agy-auth/
├── agy_oauth_flow.py   # script chính (Python 3, pty.fork + print mode)
└── README.md
```

## Yêu cầu

- Python 3.
- `agy` đã cài (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), mặc định `~/.local/bin/agy` (`--agy-binary` nếu khác).
- Môi trường có **PTY** (script tự mở PTY bằng `pty.fork` — không cần terminal thật).

## Cách chạy

```bash
python3 agy_oauth_flow.py --outdir ./out
```

Tùy chọn:

```bash
# code có sẵn trong file (1 dòng) — dùng được trong CI/không cần người ngồi máy
python3 agy_oauth_flow.py --code-file /path/to/auth-code --outdir ./out

# dùng lại HOME đã có token (không login lại, chỉ chạy prompt để bắt URL #2)
python3 agy_oauth_flow.py --home /path/to/home --outdir ./out

# giữ lại HOME tạm sau khi chạy (mặc định xoá)
python3 agy_oauth_flow.py --keep-home --outdir ./out

# custom binary / timeout / prompt
python3 agy_oauth_flow.py --agy-binary /opt/agy --timeout 600 --prompt "Reply with OK" --outdir ./out
```

## Các bước — tự động hay thủ công?

| Bước | Loại | Mô tả |
|------|------|-------|
| Tạo HOME tạm + preseed onboarding/settings | 🔧 **Tự động** | bỏ toàn bộ onboarding & trust prompt |
| Chạy `agy -p "Reply with OK"` trên PTY | 🔧 **Tự động** | `pty.fork()`, PTY rộng 2000 cột (URL không wrap) |
| Bắt **URL #1** (OAuth) | 🔧 **Tự động** | plain-text từ output, regex + ghi `oauth-url.txt` |
| Mở URL #1, đăng nhập Google, copy code | 👤 **Thủ công — ngoài terminal** | thao tác trên browser |
| Dán **authorization code** | 👤 **Thủ công — duy nhất** | script in `> ` chờ dán (hoặc `--code-file`) |
| Gửi code vào AGY | 🔧 **Tự động** | gửi code + Enter qua PTY stdin |
| Login + Eligibility Check | 🔧 **Tự động** | AGY tự chạy |
| Bắt **URL #2** (verify) nếu fail | 🔧 **Tự động** | quét output + tail `--log-file`, ghi `verify-url.txt` |
| Lưu token (nếu login thành công) | 🔧 **Tự động** | copy `antigravity-oauth-token` ra outdir |

## Quan trọng về PKCE

Mỗi lần chạy AGY sinh **PKCE verifier/challenge mới**; authorization code **dùng 1
lần** và **gắn với đúng URL của lần chạy đó**:

- Code lấy từ URL lần chạy A **không dùng được** ở lần chạy B → `invalid_grant` / `Invalid code verifier`.
- Script chờ bạn dán code **ngay trong lần chạy đó**; nếu quá lâu, AGY thoát sau
  `~60s` (auth-wait không cấu hình được) → chạy lại để lấy URL mới.
- Luôn mở **đúng URL mới** script in ra (nên dùng incognito).

## Kết quả đầu ra (`--outdir`, mặc định `out/`)

| File | Nội dung |
|------|----------|
| `oauth-url.txt` | URL #1 nguyên bản |
| `oauth-qr.png` | QR của URL #1 để quét bằng điện thoại (cần `pip install "qrcode[pil]"` hoặc `segno`, nếu thiếu chỉ in URL + gợi ý quét QR trên Web UI) |
| `verify-url.txt` | URL #2 nguyên bản (nếu có) |
| `verify-qr.png` | QR của URL #2 để quét bằng điện thoại (điều kiện như trên) |
| `antigravity-oauth-token` | token sau login (nếu có) — **credential nhạy cảm** |
| `urls.txt` | mọi URL bắt được, de-dup giữ thứ tự |
| `agy-output.raw` / `agy-output.txt` | output PTY (raw / đã strip ANSI) |
| `status` | `oauth_url=yes/no`, `verify_url=yes/no`, lỗi nếu có |

Exit code: `0` nếu bắt được URL #1; `1` nếu không (vd. HOME đã có token → không login).

## Các trường hợp thực tế

**1. Chưa login (mặc định — HOME tạm mới):**
OAuth URL → dán code → login → Eligibility Check → **verify URL nếu chưa eligible**;
nếu eligible thì không có URL #2 (chỉ có "OK").

**2. Đã login (`--home` có sẵn token):**
Không có URL #1; script chạy prompt headless → bắt URL #2 nếu tài khoản bị
ineligible. Tài khoản đã verify: không có URL nào, exit 1.

**3. Code sai/đã dùng:**
Script phát hiện `token exchange failed`, ghi vào `status`, exit 0 (đã có URL #1).

## Ghi chú bảo mật

- Không in `access_token`/`refresh_token`/code ra output.
- URL #2 có `plt=...` (page-load token tạm của Google) do AGY in ra — giữ nguyên.
- ToS/data-sharing checkbox: print mode không hỏi (không bị bắt phải đồng ý gửi data).
- `--dangerously-skip-permissions` auto-approve cả file-write & command — chỉ dùng trong môi trường đã kiểm soát.
- `antigravity-oauth-token` và `auth-code` là dữ liệu nhạy cảm — xoá sau khi dùng, đừng commit.
