#!/usr/bin/env python3
"""PTY driver for Antigravity CLI authentication + official eligibility verification.

This intentionally does NOT bypass AGY account eligibility. It drives the normal CLI
flow, captures the OAuth URL and, when AGY requires it, the official Google account
verification URL printed by AGY.

Two modes, two different AGY surfaces:
  * --mode login       drives the FULL INTERACTIVE TUI (`agy -i <prompt>`) over a
                       PTY. Interactive mode is required for the PKCE code prompt
                       and the onboarding screens.
  * --mode eligibility uses NON-INTERACTIVE print mode (`agy -p <prompt>`, the
                       `--print` flag: "Run a single prompt non-interactively and
                       print the response"). This runs the model once and prints the
                       plain-text response, which removes the fragile TUI screen
                       matching ("? for shortcuts" etc.) that changed across AGY
                       releases and used to leave the flow spinning forever.

Compatibility notes for AGY >= 1.2.12 (see docs/AGY_AUTH_VERIFY_RESEARCH.md):
  * 1.2.6/1.2.10 headless failures print `AGY_ERROR: {...}` on stderr and exit 3.
  * 1.1.28     `--print-timeout` expiry returns PARTIAL output and exits 0.
  * 1.2.9      headless runs wait for background tasks until the --print-timeout
               deadline (30-minute cap), so the timeout budget must be generous.
  * 1.2.5      a definitively rejected credential is auto-cleared mid-session.
  * 1.1.19     `AGY_CLI_HIDE_LOGO` / `AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS`.

Structured stdout markers consumed by the web app:
  __AGY_OAUTH_URL__=<url>
  __AGY_VERIFY_URL__=<url>
  __AGY_FLOW_STATUS__=<status>
  __AGY_FLOW_ERROR__=<reason>
  __AGY_FLOW_DETAIL__=<diagnostic only, never changes session state>
"""

import argparse
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

URL_RE = re.compile(rb"(?i)\bhttps?://[^\s\x1b\x07<>\"'{}|\\^`\x00-\x1f]+")

OAUTH_HOST_PATH = b"accounts.google.com/o/oauth2/auth"

# URL verify/appeal (#2) — path đổi theo release AGY:
#   1.2.x: accounts.google.com/signin/continue?...
#   1.4.4: accounts.google.com/v3/signin/continue?plt=...&continue=...&flowName=GlifWebSignIn
# Vì vậy so khớp nguyên chuỗi "accounts.google.com/signin/continue" sẽ TRƯỢT
# trên 1.4.x (có thêm "/v3"). Nhận diện theo host + path linh hoạt thay vì
# hard-code version.
VERIFY_URL_RE = re.compile(
    rb"(?i)accounts\.google\.com/(?:v\d+/)?(?:"
    rb"signin/continue"
    rb"|signin/speedbump"
    rb"|speedbump"
    rb"|accountappeals"
    rb")"
)


def is_verify_url(u: bytes) -> bool:
    """True nếu URL là link verification/appeal của Google Identity.

    Không bao giờ coi OAuth authorize URL là verify URL. Ngoài các path đã
    biết, mọi URL trên `accounts.google.com` không phải OAuth authorize đều
    được coi là actionable (#2) — AGY đã đổi path ít nhất một lần (1.4.x:
    thêm "/v3" trước "signin/continue") và thà đưa link đúng chủ đề còn hơn
    bỏ mất link verify.
    """
    if b"accounts.google.com" not in u:
        return False
    if OAUTH_HOST_PATH in u or b"/o/oauth2/" in u.lower():
        return False
    return True


NETWORK_ERROR_PATTERNS = (
    "connection reset by peer",
    "timed out",
    "timeout",
    "context deadline exceeded",
    "no such host",
    "temporary failure in name resolution",
    "tls: failed to verify certificate",
    "x509:",
    " eof",
    "request failed (code 403)",
    "403 forbidden",
)

# Very specific failure strings that are essentially never printed by AGY in
# benign output. Matched even without the "eligibility check failed" prefix so a
# differently-worded backend/network failure is not misreported as flow_timeout.
STRONG_NETWORK_PATTERNS = (
    "connection reset by peer",
    "tls: failed to verify certificate",
    "x509:",
    "no such host",
    "temporary failure in name resolution",
)

INELIGIBLE_PATTERNS = (
    "your current account is not eligible for antigravity",
    "account ineligible",
    "verify your account to continue",
)

LOCATION_PATTERNS = (
    "not currently available in your location",
    "user location is not supported for the api use",
)

# agy >= 1.2.6: khi một turn headless kết thúc vì lỗi agent/model API, CLI in
# một dòng JSON có tiền tố "AGY_ERROR:" ra stderr rồi exit code 3 (trước đây là 1).
# agy >= 1.1.28: lỗi fatal headless in ra stderr với marker ổn định "error:".
# Trước khi có các bản này, mọi lỗi backend đều rơi xuống nhánh cuối và bị báo
# thành "eligibility_inconclusive_no_probe_response" — che mất nguyên nhân thật.
AGY_ERROR_MARKER = "agy_error:"
HEADLESS_ERROR_MARKERS = (
    "agy_error:",
    "error: no candidate found",
    "error: quota exceeded",
    "error: resource_exhausted",
    "error: content filter",
    "error: the response was blocked",
    "error: authentication failed or timed out",
)

# Marker "error:" ổn định của 1.1.28 xuất hiện ở đầu dòng, ví dụ quan sát được
# trên agy 1.2.12: "error: authentication failed or timed out".
#
# KHÔNG khớp trần "error:" ở bất kỳ vị trí nào, vì chính installer của agy in
# dòng giả "ERROR: logging before google.Init: ..." vào stdout/stderr (quan sát
# thực tế ở 1.2.12) — khớp trần sẽ báo nhầm mọi lần chạy thành agent error.
HEADLESS_ERROR_LINE_RE = re.compile(r"(?im)^error:\s+\S.*$")
HEADLESS_ERROR_EXCLUDE = ("logging before google.init",)

# agy >= 1.1.28: khi --print-timeout hết hạn, CLI KHÔNG còn fail cứng nữa mà trả
# partial output và exit 0 kèm cảnh báo trên stderr. Nếu không phát hiện cảnh
# báo này, một probe bị cắt ngang có thể bị nhận nhầm là "đã verify".
TRUNCATION_MARKERS = (
    "print-timeout",
    "print timeout",
    "timed out after",
    "response may be truncated",
    "may be truncated",
    "truncated response",
)

# Exit code headless báo lỗi agent/model từ 1.2.6 trở đi. 1.1.20 đã sửa để exit
# code headless khớp với interactive (chỉ lỗi cấp cascade mới fail).
AGY_AGENT_ERROR_EXIT_CODES = frozenset((3,))

# 1.2.5: server từ chối dứt khoát (vd enterprise account bị revoke) sẽ khiến CLI
# tự xoá token. Trong flow login điều này biểu hiện giống hệt credential biến
# mất, nên phải báo riêng để không đề xuất "login lại" một cách vô ích.
# Cụm từ cố ý đủ cụ thể: chuỗi chung như "credential" dễ trúng màn onboarding.
STALE_CREDENTIAL_MARKERS = (
    "sign you out",
    "you have been signed out",
    "credentials have been cleared",
    "credential is no longer valid",
    "credentials are no longer valid",
    "token has been revoked",
    "your session has expired",
    "please sign in again",
)

DEFAULT_CREDENTIAL_PATH = os.path.expanduser("~/.gemini/antigravity-cli/antigravity-oauth-token")


def emit_marker(name: str, value: str) -> None:
    value = str(value).replace("\r", " ").replace("\n", " ")
    print(f"__AGY_{name}__={value}", flush=True)


def strip_ansi(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Z0-9]", "", text)
    text = re.sub(r"\x1b[@-Z\\-_]", "", text)
    text = re.sub(r"\x1b[=>]", "", text)
    return text


def clean_url(u: bytes) -> bytes:
    open_p = u.count(b"(")
    close_p = u.count(b")")
    while u:
        last = u[-1:]
        if last in b")];.,:>\"'}":
            if last == b")" and open_p >= close_p:
                break
            u = u[:-1]
        else:
            break
    return u


def collect_urls(blob: bytes):
    out = []
    for m in URL_RE.finditer(blob):
        u = clean_url(m.group(0))
        if u not in out:
            out.append(u)
    return out


def dump_tail(path: str, blob: bytes, limit: int = 16384) -> None:
    try:
        with open(path, "wb") as f:
            f.write(blob[-limit:])
    except OSError:
        pass


def read_code_file(path: str):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        if not value:
            return None
        try:
            os.remove(path)
        except OSError:
            pass
        return value.encode("utf-8")
    except OSError:
        return None


def has_headless_error_marker(low: str) -> bool:
    """True when the output carries AGY's stable `error:` line marker (1.1.28).

    Anchored to the start of a line, and the known spurious installer prefix is
    excluded so it cannot be mistaken for a fatal headless error.
    """
    if any(m in low for m in HEADLESS_ERROR_MARKERS):
        return True
    for match in HEADLESS_ERROR_LINE_RE.finditer(low):
        line = match.group(0)
        if any(x in line for x in HEADLESS_ERROR_EXCLUDE):
            continue
        return True
    return False


def classify_agy_error(text: str):
    """Parse the structured AGY_ERROR JSON emitted by agy >= 1.2.6.

    Returns (detail, payload): detail is a short human-readable string for the
    logs, payload the decoded dict (or None). (None, None) when there is no
    AGY_ERROR line. The raw line is still dumped to the probe log.

    Case handling matters: the marker is matched case-insensitively but the
    payload is parsed from the ORIGINAL text, otherwise the JSON keys get
    lowercased and lose their meaning.
    """
    for raw_line in text.splitlines():
        idx = raw_line.lower().find(AGY_ERROR_MARKER)
        if idx < 0:
            continue
        # Cắt đúng object JSON kể cả khi có text thừa phía sau (log của agy
        # đôi khi nối thêm chú thích), thay vì parse cả dòng.
        tail = raw_line[idx + len(AGY_ERROR_MARKER):]
        start = tail.find("{")
        end = tail.rfind("}")
        if start < 0 or end < start:
            return "", None
        try:
            payload = json.loads(tail[start:end + 1])
        except (ValueError, TypeError):
            return "", None
        if not isinstance(payload, dict):
            return "", None
        parts = []
        for key in ("status", "code", "error_id", "retryable"):
            if key in payload and payload[key] not in (None, ""):
                parts.append(f"{key}={payload[key]}")
        return " ".join(parts), payload
    return None, None


def http_status_from_agy_error(payload):
    """Extract an HTTP status from an AGY_ERROR payload, or None.

    A bare numeric HTTP code is just as useful as the human-readable error text:
    agy reports permission/quota/rate-limit failures numerically in the JSON.
    """
    if not isinstance(payload, dict):
        return None
    for key in ("http_status", "httpStatus", "status_code", "code"):
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and 100 <= value <= 599:
            return value
        if isinstance(value, str) and value.isdigit() and 100 <= int(value) <= 599:
            return int(value)
    return None


def run_print_probe(agy: str, probe_token: str, probe_prompt: str,
                    timeout_sec: int, verify_wait: int, mode: str):
    """Run AGY in non-interactive print mode and classify the outcome.

    Returns (status, error_reason): status in {"verified", "verification_required",
    "error"}, error_reason set when status is "error".
    """
    # agy >= 1.2.9 chờ background task tới hết deadline --print-timeout, nên
    # budget phải rộng hơn verify_wait một cách đáng kể, không chỉ +30s.
    print_timeout = max(90, int(verify_wait) + 60)
    cmd = [agy, "-p", probe_prompt, "--print-timeout", f"{print_timeout}s"]
    emit_marker("FLOW_STATUS", "eligibility_checking")

    # agy >= 1.1.19: ẩn banner logo + tắt renderer dirty-rect optimization.
    # Banner art chỉ gây nhiễu khi scrape stdout headless; escape-sequence
    # optimization có thể làm mất dòng response trong dump khi TERM=dumb.
    child_env = dict(os.environ, TERM="dumb")
    child_env.setdefault("AGY_CLI_HIDE_LOGO", "1")
    child_env.setdefault("AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS", "1")

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=print_timeout + 30,
            stdin=subprocess.DEVNULL,
            env=child_env,
        )
    except subprocess.TimeoutExpired:
        dump_tail(f"/tmp/agy-probe-{mode}-{os.getpid()}.txt", b"[probe timeout]")
        return "error", "eligibility_inconclusive_no_probe_response"

    out = proc.stdout + proc.stderr
    dump_tail(f"/tmp/agy-probe-{mode}-{os.getpid()}.txt", out)
    text = strip_ansi(out)
    low = text.lower()
    returncode = proc.returncode

    # Official verification URL (AGY requires Google account verification).
    # Checked first: a verify URL is actionable even if the run also errored.
    for m in URL_RE.finditer(out):
        u = clean_url(m.group(0))
        if is_verify_url(u):
            emit_marker("VERIFY_URL", u.decode("utf-8", "replace"))
            return "verification_required", None

    # ── 1.1.28+: --print-timeout hết hạn trả partial output và exit 0 ────────
    # Phải kiểm tra TRƯỚC bước so khớp nonce, nếu không partial output chứa
    # nonce sẽ bị báo nhầm là "verified".
    if any(m in low for m in TRUNCATION_MARKERS):
        return "error", "eligibility_probe_truncated"

    # ── Ineligible account: ưu tiên phân loại trước nhánh agent-error ────────
    # AGY 1.4.4 in "error: Eligibility check failed: ... Verify your account to
    # continue." ra stderr (exit 1) — nếu không xét trước, nhánh error bên dưới
    # sẽ báo nhầm thành eligibility_agent_error và UI mất gợi ý verify.
    if any(p in low for p in INELIGIBLE_PATTERNS):
        # Chẩn đoán: AGY báo cần verify nhưng không match được URL nào. In ra
        # các URL accounts.google.com đã thấy để lần sau đổi path còn lần ra.
        seen = []
        for m in URL_RE.finditer(out):
            u = clean_url(m.group(0)).decode("utf-8", "replace")
            if "accounts.google.com" in u and u not in seen:
                seen.append(u)
        if seen:
            emit_marker("FLOW_DETAIL", "verify_url_not_matched: " + " ".join(seen[:3]))
        return "error", "eligibility_failed_without_verify_url"

    # ── 1.2.6 / 1.2.10: AGY_ERROR JSON + exit code 3 ─────────────────────────
    agy_error, agy_payload = classify_agy_error(text)
    http_status = http_status_from_agy_error(agy_payload)
    if agy_error is not None or returncode in AGY_AGENT_ERROR_EXIT_CODES \
            or has_headless_error_marker(low):
        # Network/auth lỗi vẫn phải được phân loại riêng, nếu không sẽ thành
        # "agent error" và che mất việc backend chỉ tạm thời không ổn định.
        if any(p in low for p in STRONG_NETWORK_PATTERNS) \
                or "forbidden" in low or "permission denied" in low \
                or "failed to send request" in low \
                or http_status in (402, 403, 408, 429, 500, 502, 503, 504):
            return "error", "eligibility_network_error"
        if "authentication required" in low or "not signed in" in low \
                or "select login method" in low or http_status == 401:
            return "error", "credential_missing_or_expired"
        detail = f" (agy exit {returncode}"
        if agy_error:
            detail += f"; {agy_error}"
        detail += ")"
        emit_marker("FLOW_DETAIL", f"eligibility_agent_error{detail}")
        return "error", "eligibility_agent_error"

    # Positive evidence: the model replied with our nonce on a response line
    # (exclude the prompt itself, which contains the same nonce).
    for line in text.splitlines():
        if probe_token in line and "reply exactly" not in line.lower():
            emit_marker("FLOW_STATUS", "verified")
            return "verified", None

    if any(p in low for p in LOCATION_PATTERNS):
        return "error", "eligibility_location_unsupported"
    if "authentication required" in low or "not signed in" in low or "select login method" in low:
        return "error", "credential_missing_or_expired"
    if returncode != 0:
        # Exit non-zero mà không có marker nào khớp: vẫn phải báo lỗi thật
        # thay vì rơi xuống "không có probe response".
        emit_marker("FLOW_DETAIL", f"eligibility_agent_error (agy exit {returncode})")
        return "error", "eligibility_agent_error"
    if any(p in low for p in STRONG_NETWORK_PATTERNS):
        return "error", "eligibility_network_error"
    if "forbidden" in low or "permission denied" in low or "failed to send request" in low:
        return "error", "eligibility_network_error"
    return "error", "eligibility_inconclusive_no_probe_response"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("login", "eligibility"), default="login")
    ap.add_argument("--code-file", default=None)
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--verify-wait", type=int, default=90,
                    help="Seconds to wait after the probe is submitted before classifying the account. "
                         "agy >= 1.2.9 waits for background tasks until the --print-timeout deadline, "
                         "so 45s was too tight; keep this >= the value in AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC.")
    ap.add_argument("--agy-binary", default=None)
    ap.add_argument("--prompt", default="Reply with OK")
    ap.add_argument("--credential-path", default=DEFAULT_CREDENTIAL_PATH)
    args = ap.parse_args()

    # A successful interactive model response is our positive evidence that the
    # normal AGY eligibility gate has completed. Use a per-process nonce so TUI
    # echoes of the prompt cannot be confused with the assistant response.
    probe_token = f"AGY_ELIGIBILITY_OK_{os.getpid()}_{int(time.time() * 1000)}"
    probe_prompt = f"Reply exactly with {probe_token}"

    agy = args.agy_binary or os.path.expanduser("~/.local/bin/agy")
    if not os.path.exists(agy):
        emit_marker("FLOW_ERROR", "agy_binary_missing")
        return 127

    # ─── Eligibility mode: no PTY, use agy's non-interactive print mode ────────
    if args.mode == "eligibility":
        if not os.path.exists(args.credential_path):
            emit_marker("FLOW_ERROR", "credential_missing_or_expired")
            return 2
        final_status, final_error = run_print_probe(
            agy, probe_token, probe_prompt, args.timeout, args.verify_wait, args.mode
        )
        if final_status == "verified":
            emit_marker("FLOW_STATUS", "verified")
            return 0
        if final_status == "verification_required":
            return 10
        emit_marker("FLOW_ERROR", final_error)
        return 2

    # ─── Login mode: PTY-driven OAuth to obtain the credential, then probe ─────
    cols, rows = 2000, 60
    deadline = time.time() + max(30, args.timeout)

    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        env["PATH"] = os.path.dirname(agy) + ":" + env.get("PATH", "")
        # agy >= 1.1.19: ẩn banner logo và ép full redraw để text scrape
        # không bị renderer diff bỏ sót. setdefault để Dockerfile ENV thắng.
        env.setdefault("AGY_CLI_HIDE_LOGO", "1")
        env.setdefault("AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS", "1")
        os.execvpe(agy, [agy, "-i", probe_prompt], env)
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    url_stream = bytearray()
    raw_cap = 4 * 1024 * 1024  # 4 MiB — prevents unbounded memory growth
    seen_urls = []
    oauth_url = None
    verify_url = None
    menu_done = False
    login_needed = False
    code_prompt_seen = None
    code_sent = False
    code_sent_at = None
    theme_done = False
    tos_done = False
    trust_done = False
    failure_seen_at = None
    final_status = None
    final_error = None

    def send(data: bytes):
        try:
            os.write(fd, data)
        except OSError:
            pass

    emit_marker("FLOW_STATUS", "starting")

    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                data = os.read(fd, 16384)
            except OSError:
                break
            if not data:
                break
            raw += data
            url_stream += data

            if len(raw) > raw_cap:
                drop = len(raw) - raw_cap
                del raw[:drop]

            try:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except BrokenPipeError:
                return 1

            # Minimal terminal capability replies.
            reply = b""
            if b"\x1b[c" in data:
                reply += b"\x1b[?62;1;6c"
            if b"\x1b[>c" in data:
                reply += b"\x1b[>0;0;0c"
            if b"\x1b[6n" in data:
                reply += b"\x1b[1;1R"
            if b"\x1b[>q" in data:
                reply += b"\x1b[>0;1.1.11;0c"
            for mode in re.findall(rb"\x1b\[\?([0-9;]+)\$p", data):
                reply += b"\x1b[?" + mode + b";2$y"
            if b"\x1b[?u" in data:
                reply += b"\x1b[?u;1$y"
            if b"\x1b[=u" in data:
                reply += b"\x1b[=u;1;0$y"
            if reply:
                send(reply)

            # Capture official URLs exactly as printed by AGY.
            scan_blob = bytes(url_stream)
            for m in URL_RE.finditer(scan_blob):
                if m.end() == len(scan_blob):
                    continue
                u = clean_url(m.group(0))
                if u not in seen_urls:
                    seen_urls.append(u)
                if oauth_url is None and OAUTH_HOST_PATH in u:
                    oauth_url = u
                    emit_marker("OAUTH_URL", u.decode("utf-8", "replace"))
                    emit_marker("FLOW_STATUS", "oauth_url_ready")
                if verify_url is None and is_verify_url(u):
                    verify_url = u
                    emit_marker("VERIFY_URL", u.decode("utf-8", "replace"))
                    emit_marker("FLOW_STATUS", "verification_required")
                    final_status = "verification_required"

            if len(url_stream) > 65536:
                last_http = max(url_stream.rfind(b"http://"), url_stream.rfind(b"https://"))
                if last_http >= 0:
                    url_stream = bytearray(url_stream[last_http:])
                else:
                    url_stream = bytearray(url_stream[-2048:])

        text = strip_ansi(bytes(raw))
        low = text.lower()
        credential_present = os.path.exists(args.credential_path)

        # Login mode: select Google OAuth only when AGY explicitly shows the menu.
        if not menu_done and (
            "select login method" in low or "select a login method" in low
        ) and "google oauth" in low:
            login_needed = True
            time.sleep(0.4)
            send(b"\r")
            menu_done = True
            emit_marker("FLOW_STATUS", "oauth_selected")

        # Feed auth code through the code file. With --code-file we NEVER fall
        # back to blocking stdin; the web backend can create the file later.
        if oauth_url and not code_sent and "authorization code" in low:
            if code_prompt_seen is None:
                code_prompt_seen = time.time()
                emit_marker("FLOW_STATUS", "waiting_code")
            if time.time() - code_prompt_seen > 0.5:
                code = read_code_file(args.code_file) if args.code_file else None
                if code:
                    send(code + b"\r")
                    code_sent = True
                    code_sent_at = time.time()
                    emit_marker("FLOW_STATUS", "code_submitted")

        # Onboarding screens. We only need the credential; once it exists we
        # abandon this TUI session and run the non-interactive eligibility probe,
        # so auto-answer these screens conservatively while we wait.
        if code_sent and not theme_done and (
            "choose your color scheme" in low or "color scheme" in low
        ):
            time.sleep(0.35)
            send(b"\r")
            theme_done = True
            emit_marker("FLOW_STATUS", "onboarding_theme_done")

        if code_sent and not tos_done and "terms of service" in low:
            time.sleep(0.35)
            send(b" ")
            time.sleep(0.15)
            send(b"\x1b[B")
            time.sleep(0.10)
            send(b"\x1b[C")
            time.sleep(0.10)
            send(b"\r")
            tos_done = True
            emit_marker("FLOW_STATUS", "onboarding_tos_done")

        if code_sent and not trust_done and "do you trust the contents" in low:
            time.sleep(0.30)
            send(b"\r")
            trust_done = True
            emit_marker("FLOW_STATUS", "onboarding_trust_done")

        # Hard OAuth/PKCE failures.
        if "invalid code verifier" in low or "token exchange failed" in low or "invalid_grant" in low:
            final_error = "oauth_token_exchange_failed"
            emit_marker("FLOW_ERROR", final_error)
            break

        # Location/region ineligibility is not solved by a verification URL.
        if any(p in low for p in LOCATION_PATTERNS):
            final_error = "eligibility_location_unsupported"
            emit_marker("FLOW_ERROR", final_error)
            break

        # agy >= 1.2.5: khi server TỪ CHỐI DỨT KHOÁT credential (vd enterprise
        # account bị revoke) CLI tự sign out và xoá token. Nếu không phát hiện
        # ở đây, token biến mất giữa chừng sẽ bị báo nhầm thành
        # "credential_missing_or_expired" (khiến UI đề xuất Login lại vô ích).
        if credential_present and any(m in low for m in STALE_CREDENTIAL_MARKERS):
            final_error = "credential_stale_signed_out"
            emit_marker("FLOW_ERROR", final_error)
            break

        # The credential is the goal of the login phase. Once it exists (and any
        # immediate onboarding screens have been handled), stop the PTY session
        # and run the eligibility probe in non-interactive print mode.
        if code_sent and credential_present:
            # agy >= 1.1.23: prompt ngay sau login được QUEUE tới khi background
            # eligibility verification xong (trước đây bị drop kèm alert). Cửa
            # sổ 10s trước đây dễ cắt ngang lúc CLI còn đang verify nền.
            if trust_done or (code_sent_at is not None and time.time() - code_sent_at > 30):
                break

        # Code exchange finished without producing a credential.
        if code_sent and not credential_present and code_sent_at is not None \
                and time.time() - code_sent_at > 60:
            final_error = "credential_missing_or_expired"
            emit_marker("FLOW_ERROR", final_error)
            break

    if time.time() >= deadline and final_status is None and final_error is None:
        final_error = "flow_timeout"

    try:
        os.kill(pid, 15)
    except OSError:
        pass

    # Abandon the TUI session and run the official eligibility probe.
    if final_status is None and final_error is None:
        time.sleep(1.0)
        if os.path.exists(args.credential_path):
            final_status, final_error = run_print_probe(
                agy, probe_token, probe_prompt, args.timeout, args.verify_wait, args.mode
            )
        else:
            final_error = final_error or "credential_missing_or_expired"

    if final_status is None and final_error:
        emit_marker("FLOW_ERROR", final_error)

    dump_tail(f"/tmp/agy-screen-{args.mode}-{os.getpid()}.txt", strip_ansi(bytes(raw)).encode("utf-8", "replace"))

    if final_status == "verification_required":
        return 10
    if final_status == "verified":
        emit_marker("FLOW_STATUS", "verified")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
