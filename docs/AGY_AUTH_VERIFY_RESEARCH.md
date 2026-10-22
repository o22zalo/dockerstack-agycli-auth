# AGY OAuth + Eligibility Verification — Research & Design Notes

Date: 2026-08-08

## Goal

Extend `dockerstack-agycli-auth` so the web flow follows AGY's official account
eligibility process after OAuth:

1. Capture URL #1 for Google OAuth.
2. Submit the authorization code into the same AGY PTY/PKCE session.
3. Wait for the OAuth credential file, but **do not treat credential creation as
   final success**.
4. Let AGY run its normal eligibility check.
5. If AGY prints its official account verification URL, expose it as URL #2.
6. After the user completes browser verification, re-check eligibility using the
   existing OAuth credential (no second OAuth code exchange).
7. Save the token only after positive evidence that AGY can pass the eligibility
   gate and execute the verification probe.

This design automates the supported AGY/Google flow. It does not bypass account,
region, subscription, age, or other eligibility controls.

## Why a real PTY is required

AGY authentication and onboarding are terminal-interactive. More importantly,
the OAuth flow uses PKCE: the authorization code is tied to the verifier created
by the process/session that generated URL #1. Starting a new `agy` process just
to submit the code can produce a verifier mismatch.

The web backend therefore keeps one real PTY alive from URL #1 through code
submission and onboarding. A 2000-column PTY is used to reduce terminal wrapping
of long Google URLs. URL parsing additionally uses an incremental buffer so a URL
split across two PTY reads is reconstructed before it is emitted.

## Upstream AGY observations

Official changelog:
https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md

Relevant changes observed in the official changelog:

- `1.0.1`: OAuth token persistence/authentication hangs fixed.
- `1.1.2`: print mode gained OAuth authorization-code paste through the
  controlling terminal (`/dev/tty` / `CONIN$`), and truly headless runs fail
  instead of blocking.
- `1.1.3`: eligibility errors that include a verification URL are shown inline
  in the input loop. This strongly supports capturing URL #2 from the normal
  interactive PTY rather than trying to construct it ourselves.
- `1.1.4`: real eligibility failure reasons were restored instead of the generic
  `unknown reason` message.
- `1.1.7`: print mode was fixed so a prompt waits until account eligibility is
  complete; the changelog explicitly notes that the previous behavior could let
  ineligible accounts pass the check that interactive mode enforced.
- `1.1.19`: new `AGY_CLI_HIDE_LOGO` and `AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS`
  environment variables.
- `1.1.23`: prompts entered right after login are queued until background
  eligibility verification completes, instead of being discarded with an
  account-verification alert.
- `1.1.28`: `--print-timeout` expiry now returns the **partial** output and exits
  **0** with a stderr warning instead of failing; fatal headless errors gain a
  stable `error:` marker on stderr.
- `1.2.6`: headless default timeout changed from 5 minutes to **unlimited**;
  agent/model failures now print a structured `AGY_ERROR: {...}` JSON line on
  stderr and exit with code **3** instead of 1.
- `1.2.9`: headless runs that left daemon processes running after exit were fixed
  (previously they could hang a script reading stdout until EOF); headless runs
  now also wait for background tasks until the `--print-timeout` deadline, capped
  at 30 minutes.
- `1.2.10`: a headless run that streamed part of a response and then ended on a
  model or agent error now exits with code 3 and prints the `AGY_ERROR` line,
  instead of exiting 0.
- `1.2.5`: a credential the sign-in server definitively rejects is now cleared
  automatically, so a stale token disappears mid-session.

Design consequence: this project uses interactive PTY behavior as the source of
truth and never adds a `skip eligibility` path.

### 1.4.4 upgrade + auto-update on container start (2026-10-22)

Deployed version moved **1.2.12 → 1.4.4**. Because the upstream installer always
serves `latest` from `manifests/<platform>.json`, build-time pinning was never
reliable, and a Docker restart/recreate (without `--build`) kept whatever binary
was baked into the image layer. That is now handled at runtime:

- `services/agy-dev/entrypoint.sh` runs before `CMD` on **every** container start.
  It fetches `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_<arch>.json`,
  compares `version` with `agy --version`, and on mismatch installs through the
  official `install.sh` into a staging dir (`--dir /tmp/agy-update`, temp `HOME`
  so `/root/.bashrc|.profile|.zshrc` are not appended to), verifies the staging
  binary, then atomically `mv`s it over `/root/.local/bin/agy`.
- Failure is non-fatal: unreachable manifest, failed download, or bad checksum →
  the existing binary is kept and the container still starts.
- `AGY_AUTO_UPDATE=0` disables the check; `AGY_UPDATE_INTERVAL_SEC=<N>` re-checks
  every N seconds while the container runs (default `0` = start only).
- `AGYCLI_AUTH_AGY_EXPECTED_VERSION` is intentionally **empty** now. A stale pin
  (`1.2.12`) would fail the build the moment upstream serves 1.4.4.
- `agy 1.4.4 --help` still exposes `-p/--print` and `--print-timeout`, which is
  what `agy_oauth_flow.py` drives. The full OAuth/verify flow still needs a live
  login run to be re-validated end-to-end.

### 1.4.4 verify URL moved to /v3 (2026-10-22, fixed in 2.4.1)

`agy 1.4.4` changed the eligibility/verification URL (#2). Observed live on a
signed-in account that is not eligible (free/starter quota), via
`agy -p "<prompt>" --print-timeout 95s`:

```
stderr: error: Eligibility check failed: Your current account is not eligible
        for Antigravity. Verify your account to continue.
stderr: Please verify your account in your browser to continue:
        https://accounts.google.com/v3/signin/continue?plt=<128 chars>&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&sarp=1&scc=1&flowName=GlifWebSignIn&authuser
```

Key facts:

- Path gained a **`/v3`** segment: `accounts.google.com` + `/v3` + `/signin/continue`.
  Matching the literal `accounts.google.com/signin/continue` therefore fails on
  every 1.4.x run, which is why URL #2 disappeared from the UI.
- The URL is printed on **stderr** (the driver already classifies `stdout+stderr`
  combined).
- The text starts with `error: Eligibility check failed: ...`, which the generic
  `error:`/`AGY_ERROR` branch used to claim first → mislabelled
  `eligibility_agent_error`. Ineligible text is now classified before that branch.
- URL #1 (OAuth authorize) is unchanged:
  `accounts.google.com/o/oauth2/auth?...redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback...`
- The printed URL ends with `&authuser` (no `=N`). It is kept verbatim — never
  rewrite an official Google URL.

Matching rule now used by the driver (`services/agy-dev/agy_oauth_flow.py`) and
the standalone tool (`services/agy-verify/agy_oauth_flow.py`):

```python
def is_verify_url(u: bytes) -> bool:
    if b"accounts.google.com" not in u:
        return False
    if b"/o/oauth2/" in u.lower():   # URL #1 is not a verify URL
        return False
    return True
```

`services/app/src/routes/login.js` applies the same rule in
`isGoogleVerifyUrl()`. Rationale: AGY has already changed this path once, so
host-level detection (excluding the OAuth authorize path) is more durable than a
version-specific path allowlist; a future path change (`speedbump`,
`accountappeals`, …) keeps working. When AGY prints a verify hint but no URL is
matched, the driver emits
`__AGY_FLOW_DETAIL__=verify_url_not_matched: <seen urls>` for diagnostics.


### 1.2.12 upgrade (2026-09-29)

Deployed version moved from a 1.1.11-era image to **1.2.12**. `agy` is not
version-pinned by this stack — the upstream installer has no version flag and
always installs whatever `manifests/<platform>.json` serves. The only control is
the post-install `AGY_EXPECTED_VERSION` guard in `agy-install.sh`, which was
**enabled** for that release (`AGYCLI_AUTH_AGY_EXPECTED_VERSION=1.2.12`). Since
1.4.4 the guard is empty and the runtime entrypoint owns version selection.

Two properties of the guard matter when operating it:

- The guard used to be a bare **substring** match, so a partial pin such as `1.2.1`
  silently accepted `1.2.10`/`1.2.11`/`1.2.12`. `agy-install.sh` now extracts the
  first version token from `agy --version`, strips a leading `v`, and compares
  exactly. A pin that is not a full `x.y.z` version, or output that cannot be
  parsed, fails the build rather than being guessed at.
- `agy` self-updates in the background during normal runs, and the binary lives in
  the container's writable layer (only `/root/.gemini` is a volume). The build-time
  guard therefore gives **no** protection after boot; only the container healthcheck
  and the per-login `checkAgyBinary()` can observe a runtime drift.

Code changes required by the deltas above, all in
`services/agy-dev/agy_oauth_flow.py`:

| Upstream change | Consequence | Fix |
| --- | --- | --- |
| `1.2.6`/`1.2.10` `AGY_ERROR` + exit 3 | probe failures were reported as `eligibility_inconclusive_no_probe_response`, hiding the real cause | added `classify_agy_error()` / `http_status_from_agy_error()` and a `returncode` check |
| `1.1.28` partial output on timeout | a truncated probe could be accepted as `verified` if the partial text contained the nonce | truncation markers are checked **before** nonce matching; new `eligibility_probe_truncated` reason |
| `1.2.9` background-task wait | the old `verify_wait + 30s` budget was too tight | budget widened to `max(90, verify_wait + 60)`, and `AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC` raised `45` → `90` |
| `1.2.5` auto-cleared credential | a revoked token looked identical to a missing one, so the UI told the user to log in again pointlessly | new `credential_stale_signed_out` reason, treated as non-retryable |
| `1.1.19` new env vars | banner art and renderer deltas polluted the scraped text | `AGY_CLI_HIDE_LOGO` / `AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS` set in the image and in both child environments |
| `1.1.23` queued prompts | the 10s grace window after code submission could cut off the TUI mid background-verification | window raised to 30s |

A diagnostic-only `__AGY_FLOW_DETAIL__` marker was added so the exit code and
decoded `AGY_ERROR` fields reach the auth log without changing session state.
`MARKER_RE` in `services/app/src/routes/login.js` was widened to accept it.

Still **not** done, and deliberately so: agy 1.1.8 added
`--output-format json` to print mode, which would let the eligibility probe
verify against structured output instead of substring-matching a nonce. That is a
bigger behavioral change and needs a real container run to validate, so it is left
for a follow-up rather than folded into this upgrade.

### Empirically verified against the 1.2.12 binary

Verified on 2026-09-29 by building `agy-dev` from the repo `Dockerfile` and running
the driver inside the container. Three results contradict or refine the changelog:

1. **The spurious installer prefix is still present.** 1.2.0 claims to have removed
   `ERROR: logging before google.Init` from log output, but agy 1.2.12 still prints
   it during installation:

   ```text
   ERROR: logging before google.Init: I0929 03:24:06 installer.go:27] Running Antigravity CLI setup...
   ```

   This is the reason the driver does **not** match a bare `error:` substring. The
   `1.1.28` `error:` marker is instead matched anchored to the start of a line
   (`^error:\s+\S.*$`), with the known `logging before google.init` prefix excluded,
   so the installer's own noise can never be misread as a fatal headless error.

2. **The real `1.1.28` marker text is** `error: authentication failed or timed out`.
   Confirmed by running `agy -p "…" --print-timeout 90s` with no valid credential:

   ```text
   Authentication required. Please visit the URL to log in:
     https://accounts.google.com/o/oauth2/auth?access_type=offline&…
   Waiting for authentication (timeout 60s)...
   Or, paste the authorization code here and press Enter:
   Error: authentication timed out.
   error: authentication failed or timed out
   ```

3. **Authentication failure exits with code 1, not 3.** Only agent/model failures
   use exit 3. The driver relies on this: it checks the authentication strings
   before falling through to the `returncode != 0` classification, so an
   unauthenticated probe is reported as `credential_missing_or_expired` rather than
   as a generic agent error.

Also confirmed against the real binary: `--print-timeout` now defaults to `0s`
(unlimited), which is why the driver must keep passing it explicitly, and that
`--output-format` / `--json-schema` are available for the follow-up work above.

## Upstream failure modes worth classifying separately

### Verification URL can be temporary

Issue #688 reports OAuth succeeding and an eligibility verification URL later
returning HTTP 400 when opened after the fact:
https://github.com/google-antigravity/antigravity-cli/issues/688

Design consequence:

- Display URL #2 immediately.
- Do not store it as a durable credential.
- Let `Check Again` obtain the current AGY result and a new URL if AGY still
  requires verification.

### Profile-image/network failures can look like eligibility failures

Issue #621 reports fatal eligibility startup failures when
`lh3.googleusercontent.com` is blocked or TLS inspection causes x509 failures:
https://github.com/google-antigravity/antigravity-cli/issues/621

Design consequence: `403`, x509/TLS, profile-picture failures, EOF, DNS failure,
timeout, reset-by-peer, and similar backend/network symptoms must not be shown as
`verification required` unless AGY actually emits URL #2.

### Proxy handling has had regressions

Issue #181 reports eligibility requests ignoring `HTTPS_PROXY`/`HTTP_PROXY` in a
corporate network:
https://github.com/google-antigravity/antigravity-cli/issues/181

Issue #415 reports a version-specific eligibility connection-reset regression:
https://github.com/google-antigravity/antigravity-cli/issues/415

Design consequence:

- Record the installed AGY version in login diagnostics.
- Keep network/backend errors retryable and distinct from account verification.
- In production, optionally set `AGYCLI_AUTH_AGY_EXPECTED_VERSION` after testing
  a known-good AGY version. The Docker build then fails if Google's installer
  unexpectedly returns another version.
- Healthcheck executes `agy --version`, not just `command -v agy`.

## Implemented state machine

```text
starting
  -> waiting_url
  -> url_ready / waiting_code
  -> credential_wait
  -> checking_eligibility
       -> verified
            -> save Firebase token
            -> success
       -> verification_required
            -> show official URL #2
            -> checking_verification
                 -> verified -> save -> success
                 -> verification_required -> show current URL #2 again
                 -> eligibility_error / eligibility_unknown
       -> eligibility_error / eligibility_unknown
```

## Positive verification evidence

The system does **not** conclude `verified` just because no URL #2 appeared for a
fixed number of seconds.

Once AGY reaches the interactive prompt, the PTY driver submits a per-run nonce
probe such as:

```text
Reply exactly with AGY_ELIGIBILITY_OK_<pid>_<timestamp>
```

The driver only emits `verified` after a response-like line containing that nonce
is observed. If there is no conclusive response before the configured timeout,
the result becomes `eligibility_inconclusive_no_probe_response` and the token is
not saved.

## New configuration

```env
# Production guard; empty = accept the version installed upstream.
# Since 1.4.4 the stack runs "always latest": the agy-dev entrypoint re-checks
# the upstream manifest on every container start. Set a full x.y.z here only to
# hard-lock a version you have already validated (matched exactly, not substring).
AGYCLI_AUTH_AGY_EXPECTED_VERSION=

# Runtime auto-update (agy-dev entrypoint). 1 = on (default), 0 = off.
AGYCLI_AUTH_AGY_AUTO_UPDATE=1
# Re-check upstream every N seconds while the container runs (0 = start only).
AGYCLI_AUTH_AGY_UPDATE_INTERVAL_SEC=0

# PTY auth/eligibility flow timeout (seconds).
AGYCLI_AUTH_AGY_LOGIN_FLOW_TIMEOUT_SEC=420

# Maximum wait for a positive probe response (seconds).
# Raised 45 -> 90 for agy 1.2.9, which waits for background tasks until the
# --print-timeout deadline before the response is considered final.
AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC=90

# Credential file wait after OAuth code submit (milliseconds).
AGYCLI_AUTH_AGY_CREDENTIAL_CHECK_TIMEOUT_MS=60000

# Normal login session timeout (milliseconds).
AGYCLI_AUTH_SESSION_TIMEOUT_MS=600000

# Extended timeout while the user completes URL #2 (milliseconds).
AGYCLI_AUTH_VERIFICATION_SESSION_TIMEOUT_MS=1200000
```

## Error reasons emitted by the driver

| Reason | Meaning | Retryable |
| --- | --- | --- |
| `oauth_token_exchange_failed` | the authorization code was wrong, reused, or not from this PKCE session | no |
| `agy_binary_missing` | `agy` is not resolvable inside the container | no |
| `credential_missing_or_expired` | no credential file after code exchange, or AGY demands sign-in | no |
| `credential_stale_signed_out` | AGY auto-cleared a credential the server definitively rejected (agy 1.2.5) | no |
| `eligibility_location_unsupported` | account/region is not serviceable; URL #2 will not help | no |
| `eligibility_network_error` | backend/network failure (x509, DNS, 403/429/5xx, reset) | yes |
| `eligibility_probe_truncated` | `--print-timeout` expired and AGY returned partial output with exit 0 (agy 1.1.28) | yes |
| `eligibility_agent_error` | agent/model failure: `AGY_ERROR` JSON, `error:` marker, or a non-zero exit code | yes |
| `eligibility_failed_without_verify_url` | AGY reported ineligibility but printed no URL #2 | yes |
| `eligibility_inconclusive_no_probe_response` | no probe response and no error signal at all | yes |
| `flow_timeout` | the whole PTY flow expired | yes |

## Operational recommendations

1. Test a specific AGY build in staging before changing the production version
   guard.
2. Keep the raw URL #2 ephemeral; do not persist it to Firebase or long-lived
   logs.
3. When eligibility fails without URL #2, inspect the classified reason before
   asking the user to verify. Network, location, credential, and backend errors
   need different remediation.
4. Keep SSE replay enabled so reconnecting browsers recover URL #1, URL #2, and
   final token-saved state.
5. If AGY changes its TUI wording, prefer adding a new conservative pattern and
   returning `unknown` over guessing `verified`.
6. When bumping `agy`, change `AGYCLI_CACHE_BUILD` **and** rebuild with
   `--no-cache`. That value is a Docker build argument with four separate
   defaults (`.env`, `.env.example`, `compose.apps.yml`, `services/agy-dev/Dockerfile`);
   a stale BuildKit cache has silently served an old `agy` layer before, and CI
   (`docker-compose/scripts/ci-build.sh`) reuses `type=gha` cache scopes.
7. After any `agy` bump, re-run the eligibility probe against a real container
   before locking a version with `AGYCLI_AUTH_AGY_EXPECTED_VERSION`. The guard
   fails the build rather than rolling back, and the newest upstream release can
   change TUI strings the onboarding matchers depend on.
8. Since 1.4.4 the container auto-updates `agy` from the upstream manifest on
   every start (`services/agy-dev/entrypoint.sh`). If a new release breaks the
   OAuth/verify matchers, turn the updater off (`AGYCLI_AUTH_AGY_AUTO_UPDATE=0`)
   and rebuild an image from a known-good commit before redeploying.
