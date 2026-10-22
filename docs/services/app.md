# Service: `app` — agy-cli-auth

Web app tự động hoá luồng OAuth của Antigravity CLI (`agy`) và backup OAuth
token vào Firebase Realtime Database. Chạy như service `app` trong stack với
container name `main-app`.

> File compose: [`compose.apps.yml`](../../compose.apps.yml)
> Source code: [`services/app/`](../../services/app)
> Sibling CLI container: [`services/agy-dev/`](../../services/agy-dev)

---

## Kiến trúc

```
Frontend (Falcon Dashboard UI – served from /public)
    │  POST /api/login/start
    │  GET  /api/login/stream/:sessionId  (SSE)
    │  POST /api/login/submit-code
    │  POST /api/login/verify-check
    │  GET  /api/tokens
    ▼
Backend Express (services/app)
    │  docker exec ${AGYCLI_AUTH_CONTAINER_NAME}
    │  keep same PTY for OAuth/PKCE
    │  wait for AGY eligibility result
    │  verified → read token → Firebase Admin SDK
    │  not verified → expose official URL #2 → re-check
    ▼
Container `agy-dev` (sibling, services/agy-dev)
    │  Python PTY driver + official `agy` binary
    │  /root/.gemini/antigravity-cli/antigravity-oauth-token
    ▼
Firebase Realtime Database
    /tokens/{sanitizedEmail}/raw
    /tokens/{sanitizedEmail}/parsed
```

---

## Yêu cầu phía host

1. **Docker Engine** trên host phải reachable. App mount
   `/var/run/docker.sock` để gọi `docker exec` vào sibling container `agy-dev`.
2. **Firebase service account JSON** — chọn 1 trong 2 cách:
   - Set `AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64` (base64 của JSON, không
     xuống dòng) — ưu tiên cao hơn.
   - Đặt file JSON vào host theo `AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH`
     (mặc định `./serviceAccount.json`); compose mount read-only vào
     `/run/secrets/firebase-adminsdk.json`.

`/health` endpoint sẽ trả về trạng thái docker + firebase chi tiết:

```json
{
  "ok": true,
  "firebase": { "ready": true, "databaseUrl": "...", "projectId": "..." },
  "docker": { "available": true, "daemonOk": true, "error": null },
  "container": "agy-dev",
  "timestamp": 1779868782623
}
```

---

## Biến môi trường

| Biến (.env)                                            | Vai trò                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `APP_PORT`                                             | Port app lắng nghe (source of truth, dùng cho healthcheck + Caddy).      |
| `APP_HOST_PORT`                                        | Port bind ra host (mặc định 127.0.0.1).                                  |
| `HEALTH_PATH`                                          | `/health` — endpoint trả 200 khi app sẵn sàng.                           |
| `AGYCLI_AUTH_CONTAINER_NAME`                           | Tên container sibling chạy `agy` CLI (mặc định `agy-dev`).               |
| `AGYCLI_AUTH_AGY_CREDENTIAL_PATH`                      | Path file OAuth token bên trong `agy-dev`.                               |
| `AGYCLI_AUTH_AGY_SNAPSHOT_ROOTS`                       | Thư mục root scan để snapshot login state.                               |
| `AGYCLI_AUTH_AGY_SNAPSHOT_OUTPUT_DIR`                  | Thư mục output snapshot bên trong app container.                         |
| `AGYCLI_AUTH_AGY_SNAPSHOT_COPY_LIMIT`                  | Số file tối đa copy mỗi lần snapshot.                                    |
| `AGYCLI_AUTH_AGY_SNAPSHOT_MAX_FILE_BYTES`              | Kích thước tối đa cho mỗi file snapshot (byte).                          |
| `AGYCLI_AUTH_SESSION_TIMEOUT_MS`                       | Auto-cleanup login session sau N ms (mặc định 600000 = 10 phút).         |
| `AGYCLI_AUTH_VERIFICATION_SESSION_TIMEOUT_MS`          | Gia hạn session khi đang chờ URL #2/verify (mặc định 1200000 = 20 phút). |
| `AGYCLI_AUTH_AGY_EXPECTED_VERSION`                      | Build guard chặn AGY version chưa test. Để trống = chấp nhận latest (mặc định hiện tại); bật lại khi cần khoá cứng, nhớ ghi đủ `x.y.z`. |
| `AGYCLI_AUTH_AGY_AUTO_UPDATE`                           | `1` = entrypoint `agy-dev` tự nâng agy lên bản mới nhất mỗi lần container start; `0` = tắt (dùng binary trong image). |
| `AGYCLI_AUTH_AGY_UPDATE_INTERVAL_SEC`                   | `>0` = kiểm tra lại bản mới mỗi N giây lúc container đang chạy; `0` = chỉ kiểm tra lúc start. |
| `AGYCLI_AUTH_AGY_MANIFEST_BASE_URL`                     | Base URL manifest upstream (`<base>/manifests/linux_amd64.json`).        |
| `AGYCLI_AUTH_AGY_UPDATE_URL`                            | URL `install.sh` chính thức dùng khi cần cài bản mới.                    |
| `AGYCLI_AUTH_AGY_LOGIN_FLOW_TIMEOUT_SEC`                | Timeout tổng cho PTY auth/eligibility flow (mặc định 420s).              |
| `AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC`                 | Timeout chờ probe response/eligibility rõ ràng (mặc định 90s, nâng từ 45s cho agy 1.2.9). |
| `AGYCLI_AUTH_AGY_CREDENTIAL_CHECK_TIMEOUT_MS`           | Timeout chờ credential sau OAuth code (mặc định 60000ms).                |
| `AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64`          | Base64 service account JSON (ưu tiên).                                   |
| `AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH`       | Path JSON trên host, mount RO vào `/run/secrets/firebase-adminsdk.json`. |
| `AGYCLI_AUTH_FIREBASE_PROJECT_ID`                      | Fallback project ID nếu JSON không có.                                   |
| `AGYCLI_AUTH_FIREBASE_DATABASE_URL`                    | Fallback RTDB URL nếu JSON không có.                                     |

Compose map các giá trị `AGYCLI_AUTH_*` ở trên thành các tên không-prefix mà
code app sử dụng (`CONTAINER_NAME`, `AGY_*`, `FIREBASE_*`, `SESSION_TIMEOUT_MS`).

---

## Volumes

| Mount                                                                                | Mục đích                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `${DOCKER_VOLUMES_ROOT}/app/logs` → `/app/logs`                                      | Log app.                                                |
| `${DOCKER_VOLUMES_ROOT}/app/data` → `/app/data`                                      | Persistent data (reserved cho tương lai).               |
| `${DOCKER_VOLUMES_ROOT}/app/login-snapshot` → `/app/login-snapshot`                  | Snapshot từng phiên login (debug).                      |
| `${AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH}` → `/run/secrets/firebase-adminsdk.json:ro` | Firebase service account JSON (read-only).      |
| `/var/run/docker.sock` → `/var/run/docker.sock`                                      | Cho phép `docker exec` vào `agy-dev`.                   |

Sibling `agy-dev`:

| Mount                                          | Mục đích                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| `${DOCKER_VOLUMES_ROOT}/agy-dev/gemini` → `/root/.gemini` | Persistent OAuth state của `agy` CLI.        |

Tất cả volumes nằm dưới `${DOCKER_VOLUMES_ROOT}` → được Rclone backup khi
`ENABLE_RCLONE=true`.

---

## Luồng OAuth + Eligibility/Verify

```text
Start Login
  → URL #1 (Google OAuth)
  → submit authorization code vào CÙNG PTY/PKCE session
  → credential file xuất hiện
  → AGY eligibility check
      ├─ probe response thành công → VERIFIED → save Firebase token
      ├─ AGY in URL #2           → VERIFICATION_REQUIRED
      │    → user verify trên browser
      │    → POST /api/login/verify-check
      │    → dùng credential hiện có, không OAuth lại
      └─ network/location/error  → ELIGIBILITY_ERROR / UNKNOWN, không save token
```

URL #2 được giữ nguyên như AGY in ra; backend không tự dựng, không decode và
không thêm `login_hint`. Đây là luồng verify chính thức, không bypass eligibility.

## SSE / Streaming

Frontend dùng Server-Sent Events (`/api/login/stream/:sessionId`). Caddy reverse
proxy đã bật `flush_interval=-1` để stream không bị buffer:

```yaml
- "caddy.reverse_proxy.flush_interval=-1"
- "caddy_1.reverse_proxy.flush_interval=-1"
```

---

## Auth

App protected bởi Tinyauth `forward_auth` (4 label invariant):

```yaml
- "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
- "caddy.forward_auth.uri=/api/auth/caddy"
- "caddy.forward_auth.header_up=X-Forwarded-Proto https"
- "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
```

Mọi request đi qua Caddy đều bị Tinyauth chặn nếu chưa login.

---

## Healthcheck

```bash
wget -qO- http://localhost:${APP_PORT}${HEALTH_PATH:-/health} || exit 1
```

Chạy mỗi 30s, timeout 5s, retries 3, `start_period: 15s`.

---

## API endpoints

| Method | Path                              | Mô tả                                              |
| ------ | --------------------------------- | -------------------------------------------------- |
| POST   | `/api/login/start`                | Bắt đầu phiên login (`{ email, sessionId }`).       |
| GET    | `/api/login/stream/:sessionId`    | SSE stream sự kiện phiên login.                    |
| POST   | `/api/login/submit-code`          | Submit auth code (`{ sessionId, code }`).           |
| POST   | `/api/login/verify-check`         | Re-check eligibility bằng credential OAuth hiện có. |
| POST   | `/api/login/reset`                | Kill phiên login + cleanup (`{ sessionId }`).       |
| GET    | `/api/tokens`                     | Liệt kê token đã lưu (chỉ metadata).               |
| GET    | `/api/deploy-info`                | Thông tin deploy + runner env (debug).             |
| GET    | `/health`                         | Cấu trúc trạng thái docker + firebase.              |

---

## Troubleshooting

| Triệu chứng                                                | Cách xử lý                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `firebase.ready: false`                                    | Set `AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64` hoặc đặt JSON file đúng path. |
| `docker.daemonOk: false`                                   | Kiểm tra `/var/run/docker.sock` có được mount + daemon đang chạy.        |
| `error.code: CONTAINER_MISSING`                            | Service `agy-dev` chưa start; chạy `npm run dockerapp-exec:up`.          |
| `No auth URL detected within 60s`                          | Rebuild `agy-dev`: `docker compose build agy-dev` rồi up lại.            |
| Login OK nhưng SSE không update                            | Caddy thiếu `flush_interval=-1` → kiểm tra labels trong `compose.apps.yml`.|
| OAuth OK nhưng hiện `Verification required`                | Mở URL #2 ngay, hoàn tất verify Google, rồi bấm **I verified — Check Again**. |
| `Eligibility check error` nhưng không có URL #2          | Không giả định là chưa verify; xem log network/backend/location và thử **Check Again** nếu retryable. |
| URL #2 mở muộn trả HTTP 400                              | URL có token tạm; lấy URL mới bằng **Check Again** thay vì lưu URL lâu dài. |

---

## Firebase RTDB structure

```json
{
  "tokens": {
    "user_example_com": {
      "email": "user@example.com",
      "raw": "<verbatim content>",
      "parsed": { "access_token": "...", "refresh_token": "...", "expiry_date": 1716800000000 },
      "updatedAt": 1716800000000,
      "createdAt": 1716800000000,
      "lastSessionId": "abc-123-def"
    }
  }
}
```

Khuyến cáo security rules (chặn read/write public, dùng Admin SDK qua service account):

```json
{
  "rules": {
    "tokens": { ".read": false, ".write": false }
  }
}
```
