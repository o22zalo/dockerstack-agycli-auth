#!/usr/bin/env python3
"""Capture the two Antigravity CLI (`agy`) auth URLs WITHOUT any TUI interaction.

  1. Google OAuth authorization URL  (accounts.google.com/o/oauth2/auth?...)
  2. Account eligibility / verification URL (accounts.google.com/signin/continue?...)

Instead of driving the interactive TUI with key presses (login menu, onboarding
screens, chat input), this script runs `agy` in PRINT MODE (`agy -p`) under a
plain pseudo-terminal:

  * agy itself prints the OAuth URL as plain text
      "Authentication required. Please visit the URL to log in:"
    and then waits for the authorization code to be pasted back on stdin:
      "Or, paste the authorization code here and press Enter:"
  * the script feeds that code through the PTY - no arrows, no Enter, no menus.
  * after a successful login agy runs its quota/eligibility check
    (retrieveUserQuotaSummary -> PERMISSION_DENIED/VALIDATION_REQUIRED) which
    carries the verification URL; it is captured from both the PTY output and
    the --log-file, which is the guaranteed source.

No TUI capability replies, no login-menu selection, no onboarding handling are
needed: print mode skips all of that. The only remaining manual step is opening
the OAuth URL in a browser and pasting the one-time authorization code
(or providing it in advance via --code-file).

Key facts verified against agy v1.1.11 (SUPERSEDED — this tool is not wired into
the stack; the production driver is services/agy-dev/agy_oauth_flow.py, which has
been adapted for agy 1.2.12). Exit-code and timeout reasoning below no longer
holds on 1.2.x: failures now exit 3 with an AGY_ERROR line, an expired
--print-timeout returns partial output with exit 0, and the headless default
timeout is unlimited. See docs/AGY_AUTH_VERIFY_RESEARCH.md.
  * `agy -p` without a stored token, run under a PTY, prints the OAuth URL and
    waits ~60 s for the code (the print-mode auth wait is not configurable).
  * A truly non-TTY run (CI, pipe) fails fast with "authentication required"
    and prints NO URL - so a PTY is required.
  * With a token file present, `agy -p` runs fully headlessly (no auth prompt).
  * File-based token storage is used when there is no D-Bus session or when
    SSH_* env vars are exported; GEMINI_FORCE_FILE_STORAGE=true forces it.
  * The verification URL is emitted by the backend as
    { error.details[].metadata.validation_url } of the
    daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary call
    and is written verbatim into the --log-file.

Usage:
    python3 agy_oauth_flow.py [--code-file PATH] [--outdir DIR] [--timeout SECONDS]

Example:
    python3 agy_oauth_flow.py --outdir ./out
"""
import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import sys
import tempfile
import termios
import time

OAUTH_RE = re.compile(rb"https://accounts\.google\.com/o/oauth2/auth[^\s\x1b\x07<>\"'{}]+")
VERIFY_RE = re.compile(rb"https://accounts\.google\.com/signin/continue[^\s\x1b\x07<>\"'{}]+")
URL_RE = re.compile(rb"(?i)\bhttps?://[^\s\x1b\x07<>\"'{}|\\^`\x00-\x1f]+")


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
        if last in b")];.,:>\"'}" :
            if last == b")" and open_p >= close_p:
                break
            u = u[:-1]
        else:
            break
    return u


def collect_urls(blob: bytes) -> list:
    out = []
    for m in URL_RE.finditer(blob):
        u = clean_url(m.group(0))
        if u not in out:
            out.append(u)
    return out


def show_url_with_qr(label: str, url_bytes: bytes, outdir: str = None, qr_name: str = None) -> None:
    """In URL + QR ASCII ra terminal, đồng thời lưu PNG nếu có lib.

    Không bắt buộc cài thêm lib: nếu thiếu `qrcode`/`segno` thì chỉ in URL
    và gợi ý quét QR trên Web UI (nơi luôn render QR cho cả 2 URL).
    """
    text = url_bytes.decode("utf-8", "replace") if isinstance(url_bytes, (bytes, bytearray)) else str(url_bytes)
    sys.stdout.write("\n%s:\n%s\n\n" % (label, text))
    sys.stdout.flush()
    png_saved = False
    try:
        import qrcode  # pip install "qrcode[pil]"
        qr = qrcode.QRCode(border=1)
        qr.add_data(text)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
        sys.stdout.flush()
        if outdir and qr_name:
            try:
                os.makedirs(outdir, exist_ok=True)
                qr.make_image().save(os.path.join(outdir, qr_name))
                png_saved = True
            except Exception as e:
                sys.stdout.write("[QR] Không lưu được PNG %s: %s\n" % (qr_name, e))
    except ImportError:
        try:
            import segno  # pip install segno (nhẹ, không cần Pillow để lưu PNG)
            q = segno.make(text, error="l")
            q.terminal(compact=True)
            sys.stdout.flush()
            if outdir and qr_name:
                try:
                    os.makedirs(outdir, exist_ok=True)
                    q.save(os.path.join(outdir, qr_name), scale=6)
                    png_saved = True
                except Exception as e:
                    sys.stdout.write("[QR] Không lưu được PNG %s: %s\n" % (qr_name, e))
        except ImportError:
            sys.stdout.write("[QR] Quét QR trên Web UI (auto hiện QR cho cả 2 URL).\n"
                             "     Muốn hiện QR ở terminal: pip install \"qrcode[pil]\" hoặc segno.\n")
    except Exception as e:
        sys.stdout.write("[QR] Không tạo được QR: %s\n" % e)
    if png_saved and outdir and qr_name:
        sys.stdout.write("[QR] Đã lưu %s/%s\n" % (outdir, qr_name))
    sys.stdout.flush()


def seed_home(home: str, cwd: str) -> None:
    base = os.path.join(home, ".gemini", "antigravity-cli")
    cache = os.path.join(base, "cache")
    os.makedirs(cache, exist_ok=True)
    onboarding = os.path.join(cache, "onboarding.json")
    if not os.path.exists(onboarding):
        with open(onboarding, "w") as f:
            json.dump({
                "consumerOnboardingComplete": True,
                "enterpriseOnboardingComplete": False,
                "onboardingComplete": True,
            }, f)
    settings = os.path.join(base, "settings.json")
    if not os.path.exists(settings):
        with open(settings, "w") as f:
            json.dump({"trustedWorkspaces": [cwd]}, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code-file", default=None,
                    help="File containing the Google authorization code (one line). "
                         "If omitted, the script prompts on the console when agy asks for it.")
    ap.add_argument("--outdir", default="out",
                    help="Directory for the captured artifacts (default: out/)")
    ap.add_argument("--timeout", type=int, default=300,
                    help="Overall script timeout in seconds (default: 300)")
    ap.add_argument("--print-timeout", default="90s",
                    help="agy --print-timeout (model response wait; default 90s)")
    ap.add_argument("--prompt", default="Reply with OK",
                    help="Prompt sent to agy (default: 'Reply with OK')")
    ap.add_argument("--agy-binary", default=None,
                    help="Path to the agy binary (default: ~/.local/bin/agy)")
    ap.add_argument("--home", default=None,
                    help="Use this directory as HOME instead of a fresh temp one. "
                         "If it already contains a token, no login happens.")
    ap.add_argument("--keep-home", action="store_true",
                    help="Keep the temp HOME after the run (default: delete it)")
    args = ap.parse_args()

    agy = args.agy_binary or os.path.expanduser("~/.local/bin/agy")
    if not os.path.exists(agy):
        sys.exit("agy binary not found at %s. Install it first:\n"
                 "  curl -fsSL https://antigravity.google/cli/install.sh | bash" % agy)

    os.makedirs(args.outdir, exist_ok=True)
    home = args.home or tempfile.mkdtemp(prefix="agy-auth-home-")
    seed_home(home, os.getcwd())
    logpath = os.path.join(home, "cli.log")

    # ---- spawn `agy -p` on a real PTY (no TUI interaction needed) -----------
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env["HOME"] = home
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = "2000"
        env["LINES"] = "60"
        # force file-based token storage (no D-Bus here / SSH-like session)
        env["SSH_CONNECTION"] = "127.0.0.1 50000 127.0.0.1 22"
        env["SSH_CLIENT"] = "127.0.0.1 50000 22"
        env["SSH_TTY"] = "/dev/pts/0"
        env["GEMINI_FORCE_FILE_STORAGE"] = "true"
        env["TZ"] = "UTC"
        env["PATH"] = os.path.dirname(agy) + ":" + env.get("PATH", "")
        cmd = [agy, "-p", args.prompt,
               "--print-timeout", args.print_timeout,
               "--log-file", logpath]
        os.execvpe(agy, cmd, env)
        os._exit(127)

    # wide PTY so the ~400-char OAuth URL is never hard-wrapped
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 2000, 0, 0))

    raw = bytearray()
    urls = []
    oauth_url = None
    verify_url = None
    start = time.time()
    deadline = start + args.timeout

    code_prompt_seen = None
    code_sent = False
    code = None
    error_seen = None
    verify_seen = False
    settle_from = None
    log_offset = 0

    def send(b):
        try:
            os.write(fd, b)
        except OSError:
            pass

    def note(text):
        sys.stdout.write("[AUTO] %s\n" % text)
        sys.stdout.flush()

    def save():
        txt = strip_ansi(bytes(raw))
        with open(os.path.join(args.outdir, "agy-output.raw"), "wb") as f:
            f.write(bytes(raw))
        with open(os.path.join(args.outdir, "agy-output.txt"), "w") as f:
            f.write(txt)
        with open(os.path.join(args.outdir, "urls.txt"), "w") as f:
            for u in urls:
                f.write(u.decode("utf-8", "replace") + "\n")
        if oauth_url:
            with open(os.path.join(args.outdir, "oauth-url.txt"), "w") as f:
                f.write(oauth_url.decode("utf-8", "replace") + "\n")
        if verify_url:
            with open(os.path.join(args.outdir, "verify-url.txt"), "w") as f:
                f.write(verify_url.decode("utf-8", "replace") + "\n")
        with open(os.path.join(args.outdir, "status"), "w") as f:
            f.write("oauth_url=%s\nverify_url=%s\nerror=%s\n" % (
                "yes" if oauth_url else "no",
                "yes" if verify_url else "no",
                error_seen or ""))
        token_src = os.path.join(home, ".gemini", "antigravity-cli",
                                 "antigravity-oauth-token")
        if os.path.exists(token_src):
            shutil.copy(token_src, os.path.join(args.outdir, "antigravity-oauth-token"))

    def log_tail():
        nonlocal log_offset
        try:
            size = os.path.getsize(logpath)
            if size > log_offset:
                with open(logpath, "rb") as f:
                    f.seek(log_offset)
                    chunk = f.read()
                log_offset = size
                return chunk
        except OSError:
            pass
        return b""

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
            for u in collect_urls(data):
                if u not in urls:
                    urls.append(u)
                if oauth_url is None and b"accounts.google.com/o/oauth2/auth" in u:
                    oauth_url = u
                    note("OAuth authorization URL captured.")
                    show_url_with_qr("OAuth URL", oauth_url, args.outdir, "oauth-qr.png")
                if verify_url is None and b"accounts.google.com/signin/continue" in u:
                    verify_url = u
                    verify_seen = True
                    note("Verification URL captured from output.")
                    show_url_with_qr("Verify URL", verify_url, args.outdir, "verify-qr.png")

        # tail the log file - guaranteed source for the verification URL
        for u in collect_urls(log_tail()):
            if u not in urls:
                urls.append(u)
            if oauth_url is None and b"accounts.google.com/o/oauth2/auth" in u:
                oauth_url = u
            if verify_url is None and b"accounts.google.com/signin/continue" in u:
                verify_url = u
                verify_seen = True
                note("Verification URL captured from log.")
                show_url_with_qr("Verify URL", verify_url, args.outdir, "verify-qr.png")

        txt = strip_ansi(bytes(raw))
        low = txt.lower()

        # ---- feed the authorization code once agy asks for it ---------------
        if oauth_url and not code_sent and (
                "paste the authorization code" in low or "waiting for authentication" in low):
            if code_prompt_seen is None:
                code_prompt_seen = time.time()
                if not args.code_file:
                    sys.stdout.write(
                        "[MANUAL] Open the OAuth URL above in your browser, sign in, and copy the\n"
                        "         authorization code shown afterwards. Paste it below and press Enter.\n"
                        "         agy keeps waiting ~60s. (Or use --code-file PATH.)\n\n> ")
                    sys.stdout.flush()
            if time.time() - code_prompt_seen > 1.5:
                if code is None:
                    if args.code_file:
                        if os.path.exists(args.code_file):
                            with open(args.code_file) as f:
                                code = f.read().strip()
                        else:
                            error_seen = "code file not found: %s" % args.code_file
                            break
                    else:
                        line = sys.stdin.readline()
                        code = line.strip()
                if code:
                    send(code.encode() + b"\r")
                    code_sent = True
                    note("Authorization code submitted.")
                else:
                    error_seen = "no code provided"
                    break

        # ---- verification URL settle window --------------------------------
        if verify_seen and settle_from is None:
            settle_from = time.time()
        if verify_seen and settle_from is not None and time.time() - settle_from > 5:
            save()
            break

        # ---- hard errors -----------------------------------------------------
        if "invalid code verifier" in low or "token exchange failed" in low or "invalid_grant" in low:
            error_seen = "token exchange failed (bad/invalid authorization code)"
            note("ERROR: %s" % error_seen)
            save()
            break
        if "authentication failed or timed out" in low:
            error_seen = "authentication timed out (code not pasted within agy's auth window)"
            note("ERROR: %s" % error_seen)
            save()
            break

    save()
    try:
        os.kill(pid, 15)
    except OSError:
        pass

    if not args.home and not args.keep_home:
        shutil.rmtree(home, ignore_errors=True)

    # ---- final summary ------------------------------------------------------
    print("=== DONE ===")
    print("Artifacts written to: %s/" % args.outdir)
    print("OAuth URL: %s" % (oauth_url.decode("utf-8", "replace") if oauth_url else "NOT FOUND"))
    print("Verify URL: %s" % (verify_url.decode("utf-8", "replace") if verify_url else "NOT FOUND"))
    print("QR PNG (nếu có lib qrcode/segno): %s/oauth-qr.png, %s/verify-qr.png" % (args.outdir, args.outdir))
    print("Web UI cũng luôn hiện QR cho cả 2 URL để quét bằng điện thoại.")
    if error_seen:
        print("Error: %s" % error_seen)
    if oauth_url is None and not error_seen:
        print("Note: no login happened - this HOME was already authenticated. "
              "Use a fresh HOME (default) to force a new OAuth flow.")
    # exit 0 if we captured at least the OAuth authorization URL
    return 0 if oauth_url else 1


if __name__ == "__main__":
    sys.exit(main())
