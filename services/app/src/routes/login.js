'use strict';

/**
 * routes/login.js
 *
 * Official AGY login + eligibility flow:
 *   OAuth URL -> auth code -> credential -> AGY eligibility check
 *     -> verified -> save token
 *     -> verification_required -> expose AGY's official URL #2 -> re-check
 *
 * This flow does not bypass AGY eligibility. The second URL is captured from
 * AGY's own output and the token is only marked complete after AGY no longer
 * requests account verification.
 */

const express = require('express');
const docker = require('../services/dockerService');
const sessions = require('../services/sessionManager');
const firebase = require('../services/firebaseService');
const { addEmailHint } = require('../utils/urlExtract');
const { isValidEmail, isValidSessionId } = require('../utils/sanitize');

const router = express.Router();

const log = {
  info: (msg) => console.log(`ℹ  [LOGIN] ${msg}`),
  warn: (msg) => console.warn(`⚠  [LOGIN] ${msg}`),
  err:  (msg) => console.error(`✗  [LOGIN] ${msg}`),
  ok:   (msg) => console.log(`✓  [LOGIN] ${msg}`),
};

const OAUTH_URL_RE = /https?:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s\x1b\x07<>"'{}|\\^`]+/i;
const VERIFY_URL_RE = /https?:\/\/accounts\.google\.com\/signin\/continue\?[^\s\x1b\x07<>"'{}|\\^`]+/i;
const MARKER_RE = /__AGY_(OAUTH_URL|VERIFY_URL|FLOW_STATUS|FLOW_ERROR|FLOW_DETAIL)__=([^\r\n]+)/g;

function emitAuthLog(sessionId, level, message, details = null) {
  if (level === 'error') log.err(`[${sessionId}] ${message}`);
  else if (level === 'warning') log.warn(`[${sessionId}] ${message}`);
  else if (level === 'success') log.ok(`[${sessionId}] ${message}`);
  else log.info(`[${sessionId}] ${message}`);

  sessions.appendLog(sessionId, { level, message, details });
}

function redactSecrets(text, extraSecrets = []) {
  let out = String(text || '');
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[redacted-auth-code]');
    }
  }
  return out
    .replace(/([A-Za-z0-9_-]{40,})/g, (m) => `${m.slice(0, 6)}…[${m.length} chars redacted]`)
    .replace(/([?&](?:code|token|access_token|refresh_token|client_secret|plt|state|code_challenge)=)[^&\s]+/gi, '$1[redacted]');
}

function buildAuthDiagnostics(session) {
  const out = redactSecrets(session.stdoutBuf || '', [session.authCode]).trim();
  const err = redactSecrets(session.stderrBuf || '', [session.authCode]).trim();
  const tail = (s) => (s ? s.split(/\r?\n/).slice(-30).join('\n') : '(empty)');
  let hint = '';
  const combined = `${out}\n${err}`;
  if (/__AGY_BINARY_MISSING__/.test(combined) || /agy_binary_missing/i.test(combined)) {
    hint = 'Binary `agy` không có trong container — rebuild agy-dev.';
  } else if (!out && !err) {
    hint = 'agy không in ra gì — kiểm tra container/agy và `docker logs agy-dev`.';
  }
  return {
    hint,
    text: `--- stdout (tail) ---\n${tail(out)}\n\n--- stderr (tail) ---\n${tail(err)}`,
  };
}

function cleanCapturedUrl(raw) {
  return String(raw || '').trim().replace(/[\])};,.:>"']+$/g, '');
}

function errorMessageForReason(reason) {
  switch (reason) {
    case 'oauth_token_exchange_failed':
      return 'OAuth token exchange failed. Authorization code có thể sai, đã dùng rồi, hoặc không thuộc đúng PKCE session.';
    case 'credential_missing_or_expired':
      return 'Credential AGY không còn tồn tại hoặc đã hết hiệu lực. Hãy Login lại.';
    case 'credential_stale_signed_out':
      return 'AGY đã tự sign out vì server từ chối dứt khoát credential này (từ agy 1.2.5). Token cũ đã bị xoá nên không thể dùng lại — cần một tài khoản/đăng nhập mới.';
    case 'eligibility_location_unsupported':
      return 'AGY báo tài khoản/kết nối hiện tại không được hỗ trợ theo location. Đây không phải trường hợp có thể giải quyết bằng URL verify.';
    case 'eligibility_network_error':
      return 'Eligibility check lỗi mạng/backend. Token chưa được đánh dấu verified; có thể bấm Check Again sau khi kết nối ổn định.';
    case 'eligibility_failed_without_verify_url':
      return 'AGY báo eligibility failed nhưng không in được verification URL. Hãy Check Again hoặc xem log chi tiết.';
    case 'eligibility_inconclusive_no_probe_response':
      return 'AGY không trả về probe response trong thời gian chờ. Không coi là verified; có thể do model/backend/network chậm hoặc lỗi. Hãy Check Again.';
    case 'eligibility_probe_truncated':
      return 'Probe hết --print-timeout nên AGY chỉ trả về output một phần. Từ agy 1.1.28, trường hợp này vẫn exit 0 nên không thể coi là verified. Hãy Check Again.';
    case 'eligibility_agent_error':
      return 'AGY báo lỗi agent/model khi chạy probe (exit code 3, dòng AGY_ERROR). Thường do quota, lỗi backend hoặc model không phục vụ khu vực này. Xem log chi tiết rồi Check Again.';
    case 'flow_timeout':
      return 'AGY eligibility flow hết thời gian chờ trước khi có kết quả rõ ràng.';
    case 'agy_binary_missing':
      return 'agy CLI không có trong container agy-dev.';
    default:
      return `AGY auth/eligibility error: ${reason || 'unknown'}`;
  }
}

async function finalizeVerifiedSession(sessionId) {
  const session = sessions.getSession(sessionId);
  if (!session || session.finalizing || session.status === 'success') return;
  session.finalizing = true;
  session.eligibilityStatus = 'verified';
  sessions.updateStatus(sessionId, 'verified');
  sessions.emitSSE(sessionId, { type: 'eligibility_result', outcome: 'verified' });
  emitAuthLog(sessionId, 'success', 'AGY eligibility check passed; account does not require verification.');

  try {
    if (!session.credentialReady) {
      const credentialOk = await docker.waitForCredential(docker.CONFIG.containerName);
      if (!credentialOk) throw new Error('Credential disappeared before final save.');
      session.credentialReady = true;
    }

    emitAuthLog(sessionId, 'info', 'Reading verified credential file from container.');
    const raw = await docker.readCredentialFile(docker.CONFIG.containerName);

    let snapshotReport = null;
    if (session.beforeSnapshot) {
      try {
        emitAuthLog(sessionId, 'info', `Taking after snapshot and writing report to ${docker.CONFIG.snapshotOutputDir}.`);
        const afterSnapshot = await docker.captureFileSnapshot(docker.CONFIG.containerName);
        snapshotReport = await docker.createLoginSnapshotReport({
          containerName: docker.CONFIG.containerName,
          sessionId,
          email: session.email,
          before: session.beforeSnapshot,
          after: afterSnapshot,
        });
        sessions.setLoginSnapshot(sessionId, snapshotReport);
        emitAuthLog(sessionId, 'success', `Snapshot report ready: ${snapshotReport.output.displayDir}.`, {
          summary: snapshotReport.summary,
          output: snapshotReport.output,
        });
      } catch (err) {
        emitAuthLog(sessionId, 'warning', `After snapshot/report failed: ${err.message}`);
      }
    }

    emitAuthLog(sessionId, 'info', `Saving verified token for ${session.email} to Firebase.`);
    const key = await firebase.saveToken(session.email, raw, sessionId);

    const tokenSavedEvent = {
      type: 'token_saved',
      email: session.email,
      key,
      verified: true,
      savedAt: Date.now(),
      snapshot: snapshotReport,
    };
    session.lastTokenSaved = tokenSavedEvent;
    sessions.updateStatus(sessionId, 'success', { key, verified: true, savedAt: tokenSavedEvent.savedAt });
    sessions.emitSSE(sessionId, tokenSavedEvent);

    await docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
    if (session.childProcess) {
      try { session.childProcess.kill('SIGTERM'); } catch (_) {}
    }
    docker.releaseMutex(sessionId);
    setTimeout(() => sessions.destroySession(sessionId, { reason: 'success' }), 4000);
  } catch (err) {
    session.finalizing = false;
    session.eligibilityStatus = 'error';
    sessions.updateStatus(sessionId, 'error');
    sessions.emitSSE(sessionId, { type: 'error', message: `Final save failed: ${err.message}` });
    emitAuthLog(sessionId, 'error', `Final save failed: ${err.message}`);
    await docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
    if (session.childProcess) {
      try { session.childProcess.kill('SIGTERM'); } catch (_) {}
    }
    docker.releaseMutex(sessionId);
    setTimeout(() => sessions.destroySession(sessionId, { reason: 'finalize_error' }), 4000);
  }
}

function handleFlowStatus(sessionId, session, value) {
  switch (value) {
    case 'starting':
    case 'oauth_selected':
      return;
    case 'oauth_url_ready':
      if (!session.authUrl) sessions.updateStatus(sessionId, 'waiting_url');
      return;
    case 'waiting_code':
      if (session.authUrl) sessions.updateStatus(sessionId, 'waiting_code');
      return;
    case 'code_submitted':
      sessions.updateStatus(sessionId, 'credential_wait');
      return;
    case 'onboarding_theme_done':
    case 'onboarding_tos_done':
    case 'onboarding_trust_done':
      emitAuthLog(sessionId, 'info', `AGY ${value.replace(/^onboarding_/, '').replace(/_/g, ' ')}.`);
      return;
    case 'eligibility_checking':
      session.eligibilityStatus = 'checking';
      sessions.updateStatus(sessionId, 'checking_eligibility');
      sessions.emitSSE(sessionId, { type: 'eligibility_result', outcome: 'checking' });
      return;
    case 'verification_required':
      session.eligibilityStatus = 'verification_required';
      sessions.updateStatus(sessionId, 'verification_required', { verifyUrl: session.verifyUrl || null });
      return;
    case 'verified':
      void finalizeVerifiedSession(sessionId);
      return;
    default:
      emitAuthLog(sessionId, 'info', `AGY flow status: ${value}`);
  }
}

function handleFlowError(sessionId, session, reason) {
  if (session.status === 'success') return;
  session.eligibilityStatus = 'error';
  session.eligibilityReason = reason;
  const message = errorMessageForReason(reason);

  if (reason === 'oauth_token_exchange_failed' || reason === 'agy_binary_missing') {
    sessions.updateStatus(sessionId, 'error');
    sessions.emitSSE(sessionId, { type: 'error', message });
    docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
    if (session.childProcess) {
      try { session.childProcess.kill('SIGTERM'); } catch (_) {}
    }
    docker.releaseMutex(sessionId);
    setTimeout(() => sessions.destroySession(sessionId, { reason: 'flow_error' }), 4000);
  } else {
    sessions.updateStatus(sessionId, 'eligibility_error', { reason });
    sessions.emitSSE(sessionId, {
      type: 'eligibility_result',
      outcome: 'error',
      reason,
      message,
      retryable: reason !== 'eligibility_location_unsupported' && reason !== 'credential_missing_or_expired' && reason !== 'credential_stale_signed_out',
    });
    if (reason === 'eligibility_location_unsupported' || reason === 'credential_missing_or_expired' || reason === 'credential_stale_signed_out') {
      docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
      if (session.childProcess) {
        try { session.childProcess.kill('SIGTERM'); } catch (_) {}
      }
      docker.releaseMutex(sessionId);
      setTimeout(() => sessions.destroySession(sessionId, { reason: 'flow_error' }), 4000);
    }
  }
  emitAuthLog(sessionId, 'error', message);
}

function captureOAuthUrl(sessionId, session, rawUrl) {
  if (session.authUrl) return;
  const cleaned = cleanCapturedUrl(rawUrl);
  if (!cleaned.includes('accounts.google.com/o/oauth2/auth')) return;
  const finalUrl = addEmailHint(cleaned, session.email);
  session.authUrl = finalUrl;
  sessions.updateStatus(sessionId, 'url_ready', { authUrl: finalUrl });
  sessions.emitSSE(sessionId, { type: 'auth_url', url: finalUrl });
  emitAuthLog(sessionId, 'success', 'OAuth URL #1 captured with email login_hint.');
}

function captureVerifyUrl(sessionId, session, rawUrl) {
  const cleaned = cleanCapturedUrl(rawUrl);
  if (!cleaned.includes('accounts.google.com/signin/continue')) return;
  const changed = session.verifyUrl !== cleaned;
  session.verifyUrl = cleaned;
  session.eligibilityStatus = 'verification_required';
  sessions.updateStatus(sessionId, 'verification_required', { verifyUrl: cleaned });
  sessions.refreshSessionTimeout(sessionId, sessions.VERIFICATION_SESSION_TIMEOUT_MS);
  if (changed) {
    sessions.emitSSE(sessionId, { type: 'verify_url', url: cleaned });
    emitAuthLog(sessionId, 'warning', 'AGY requires account verification; official URL #2 captured.');
  }
}

function processStructuredMarkers(sessionId, session, text) {
  session.markerRemainder = `${session.markerRemainder || ''}${text}`;
  const lines = session.markerRemainder.split(/\r?\n/);
  session.markerRemainder = lines.pop() || '';
  session.markerSeen = session.markerSeen || new Set();

  for (const line of lines) {
    MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MARKER_RE.exec(line)) !== null) {
      const kind = match[1];
      const value = String(match[2] || '').trim();
      const markerKey = `${kind}:${value}`;
      if (session.markerSeen.has(markerKey)) continue;
      session.markerSeen.add(markerKey);

      if (kind === 'OAUTH_URL') captureOAuthUrl(sessionId, session, value);
      else if (kind === 'VERIFY_URL') captureVerifyUrl(sessionId, session, value);
      else if (kind === 'FLOW_STATUS') handleFlowStatus(sessionId, session, value);
      else if (kind === 'FLOW_ERROR') handleFlowError(sessionId, session, value);
      // Diagnostic-only marker from the driver (e.g. the agy exit code behind
      // an AGY_ERROR). Never changes session state; only surfaces the cause.
      else if (kind === 'FLOW_DETAIL') emitAuthLog(sessionId, 'warning', `AGY detail: ${value}`);
    }
  }
}

function handleAgyChunk(sessionId, session, chunk, isStderr) {
  const text = chunk.toString('utf8');
  if (isStderr) session.stderrBuf += text;
  else session.stdoutBuf += text;

  processStructuredMarkers(sessionId, session, text);

  // Backward-compatible fallback if a future/older driver prints URLs without markers.
  if (!session.authUrl) {
    const found = text.match(OAUTH_URL_RE) || `${session.stdoutBuf}\n${session.stderrBuf}`.match(OAUTH_URL_RE);
    if (found) captureOAuthUrl(sessionId, session, found[0]);
  }
  const verifyFound = text.match(VERIFY_URL_RE);
  if (verifyFound) captureVerifyUrl(sessionId, session, verifyFound[0]);

  if (text.includes('__AGY_BINARY_MISSING__')) {
    handleFlowError(sessionId, session, 'agy_binary_missing');
  }
}

function attachAgyProcess(sessionId, child, kind) {
  const session = sessions.getSession(sessionId);
  if (!session) {
    try { child.kill('SIGTERM'); } catch (_) {}
    return;
  }

  // Generation counter: each new spawn (login → eligibility re-check) replaces
  // the previous child. Close/error handlers of an OLD child must not mutate a
  // session that now belongs to a NEWER child, otherwise killing the old driver
  // in verify-check can briefly flip the UI to eligibility_unknown.
  session.childGeneration = (session.childGeneration || 0) + 1;
  const generation = session.childGeneration;
  session.childProcess = child;
  session.childKind = kind;
  child.stdout.on('data', (c) => handleAgyChunk(sessionId, session, c, false));
  child.stderr.on('data', (c) => handleAgyChunk(sessionId, session, c, true));

  child.on('close', (code) => {
    const current = sessions.getSession(sessionId);
    if (!current) return;
    if (current.childGeneration !== generation) return;
    current.childExitCode = code;
    log.info(`agy ${kind} child closed for ${sessionId} (code=${code}, status=${current.status})`);

    if (code === 0 && current.status !== 'success' && current.status !== 'error') {
      log.ok(`agy ${kind} child exited with 0 (success) for ${sessionId}; finalizing session.`);
      void finalizeVerifiedSession(sessionId);
      return;
    }

    if (current.status === 'checking_eligibility' || current.status === 'checking_verification') {
      // The PTY driver normally emits verified / verification_required / error.
      // If it exits without one, keep the account unresolved rather than falsely
      // treating absence of a URL as verified.
      setTimeout(() => {
        const s = sessions.getSession(sessionId);
        if (!s) return;
        if (s.childGeneration !== generation) return;
        if (s.status === 'checking_eligibility' || s.status === 'checking_verification') {
          sessions.updateStatus(sessionId, 'eligibility_unknown');
          sessions.emitSSE(sessionId, {
            type: 'eligibility_result',
            outcome: 'unknown',
            message: `AGY process ended (code=${code}) before a conclusive eligibility result.`,
          });
          docker.cleanupFifo(docker.CONFIG.containerName, s.fifoPath).catch(() => {});
          docker.releaseMutex(sessionId);
        }
      }, 500);
    }
  });

  child.on('error', (err) => {
    log.err(`agy ${kind} spawn error for ${sessionId}: ${err.message}`);
    const current = sessions.getSession(sessionId);
    if (!current) return;
    if (current.childGeneration !== generation) return;
    sessions.updateStatus(sessionId, 'eligibility_error', { reason: 'spawn_error' });
    sessions.emitSSE(sessionId, {
      type: 'eligibility_result',
      outcome: 'error',
      reason: 'spawn_error',
      message: err.message,
      retryable: true,
    });
  });
}

// ─── POST /api/login/start ───────────────────────────────────────────────────

router.post('/start', async (req, res) => {
  const { email, sessionId } = req.body || {};

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId (alphanumeric/_- only, 8-128 chars)' });
  }
  if (sessions.getSession(sessionId)) return res.status(409).json({ error: 'Session already exists' });

  // Chống treo vô hạn khi phiên cũ bị bỏ dở (reload tab, cancel giữa chừng)
  // mà vẫn giữ mutex: chờ tối đa ~15s rồi trả 409 busy để UI đề xuất dọn dẹp.
  const mutexWaitMs = parseInt(process.env.AGY_MUTEX_WAIT_TIMEOUT_MS || '15000', 10);
  const granted = await docker.acquireMutex(sessionId, { timeoutMs: mutexWaitMs });
  if (!granted) {
    const mutex = docker.getMutexState();
    return res.status(409).json({
      error: 'Container đang bận — một phiên login khác vẫn giữ. Hãy bấm “Dọn dẹp & thử lại” để hủy phiên kẹt và chạy lại từ đầu.',
      busy: true,
      holder: mutex.holder || null,
      queued: mutex.queued,
    });
  }

  try {
    await docker.ensureContainerRunning();
  } catch (err) {
    docker.releaseMutex(sessionId);
    return res.status(500).json({ error: `Container not available: ${err.message}` });
  }

  let agyRuntime = null;
  try {
    const bin = await docker.checkAgyBinary(docker.CONFIG.containerName);
    if (!bin.ok) {
      docker.releaseMutex(sessionId);
      return res.status(500).json({ error: `agy CLI unavailable: ${bin.error}` });
    }
    agyRuntime = bin;
    log.ok(`agy binary resolved at ${bin.path} (${bin.version || 'version unknown'})`);
  } catch (err) {
    log.warn(`agy binary check errored (continuing): ${err.message}`);
  }

  const session = sessions.createSession({
    sessionId,
    email,
    onTimeout: async (timedOutSession) => {
      if (timedOutSession.childProcess) {
        try { timedOutSession.childProcess.kill('SIGTERM'); } catch (_) {}
      }
      await docker.cleanupFifo(docker.CONFIG.containerName, timedOutSession.fifoPath).catch(() => {});
      await docker.resetCredential(docker.CONFIG.containerName).catch(() => {});
      docker.releaseMutex(timedOutSession.sessionId);
    },
  });
  emitAuthLog(sessionId, 'info', `Container ${docker.CONFIG.containerName} is running; preparing auth session.`);
  if (agyRuntime) {
    emitAuthLog(sessionId, 'info', `AGY runtime: ${agyRuntime.version || 'unknown'} at ${agyRuntime.path}.`);
  }

  try {
    await docker.createFifo(docker.CONFIG.containerName, session.fifoPath);
  } catch (err) {
    docker.releaseMutex(sessionId);
    sessions.destroySession(sessionId, { reason: 'fifo_failed' });
    return res.status(500).json({ error: `Failed to create FIFO: ${err.message}` });
  }

  emitAuthLog(sessionId, 'info', `Removing old credential at ${docker.CONFIG.credentialPath}.`);
  await docker.resetCredential(docker.CONFIG.containerName);

  const child = docker.spawnAgySession({
    containerName: docker.CONFIG.containerName,
    fifoPath: session.fifoPath,
    sessionId,
  });
  sessions.updateStatus(sessionId, 'waiting_url');
  attachAgyProcess(sessionId, child, 'login');

  const urlWaitMs = docker.CONFIG.urlWaitTimeoutMs || 60_000;
  setTimeout(() => {
    const s = sessions.getSession(sessionId);
    if (s && !s.authUrl && s.status !== 'success' && s.status !== 'error') {
      const waitSec = Math.round(urlWaitMs / 1000);
      const diag = buildAuthDiagnostics(s);
      sessions.emitSSE(sessionId, {
        type: 'error',
        message: `No auth URL detected within ${waitSec}s. ${diag.hint || ''}`.trim(),
        details: { diagnostics: diag.text },
      });
      emitAuthLog(sessionId, 'error', `Timeout chờ OAuth URL (${waitSec}s).`, { diagnostics: diag.text });
    }
  }, urlWaitMs);

  return res.json({ success: true, sessionId });
});

// ─── GET /api/login/stream/:sessionId ────────────────────────────────────────

router.get('/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) return res.status(400).end();
  const session = sessions.getSession(sessionId);
  if (!session) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  sessions.attachSSE(sessionId, res);

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sessions.detachSSE(sessionId);
  });
});

// ─── GET /api/login/snapshots/:snapshotId/changed-files.tar.gz ──────────────

router.get('/snapshots/:snapshotId/changed-files.tar.gz', async (req, res) => {
  try {
    const info = await docker.getChangedFilesArchiveInfo(req.params.snapshotId);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${info.archiveName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await docker.streamChangedFilesArchive(info, res);
  } catch (err) {
    if (res.headersSent) return res.destroy(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Download failed' });
  }
});

// ─── POST /api/login/submit-code ─────────────────────────────────────────────

router.post('/submit-code', async (req, res) => {
  const { sessionId, code } = req.body || {};
  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  if (!code || typeof code !== 'string' || code.length < 4) {
    return res.status(400).json({ error: 'Invalid auth code' });
  }

  const session = sessions.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'url_ready' && session.status !== 'waiting_code') {
    return res.status(409).json({ error: `Session not ready for code (status=${session.status})` });
  }

  sessions.updateStatus(sessionId, 'waiting_code');
  session.authCode = code.trim();
  emitAuthLog(sessionId, 'info', 'Submitting authorization code into the same PTY/PKCE session.');

  try {
    session.beforeSnapshot = await docker.captureFileSnapshot(docker.CONFIG.containerName);
    emitAuthLog(sessionId, 'success', `Before snapshot captured: ${session.beforeSnapshot.fileCount} files.`);
  } catch (err) {
    emitAuthLog(sessionId, 'warning', `Before snapshot failed: ${err.message}`);
  }

  try {
    await docker.writeCodeToContainer(docker.CONFIG.containerName, session.fifoPath, code.trim());
  } catch (err) {
    sessions.emitSSE(sessionId, { type: 'error', message: `Failed to submit code: ${err.message}` });
    return res.status(500).json({ error: err.message });
  }

  sessions.updateStatus(sessionId, 'credential_wait');
  const ok = await docker.waitForCredential(docker.CONFIG.containerName, undefined, undefined, undefined, () => {
    const s = sessions.getSession(sessionId);
    return !!(s && (s.status === 'error' || s.eligibilityReason));
  });
  if (!ok) {
    const s = sessions.getSession(sessionId);
    const driverReason = s ? s.eligibilityReason : null;
    const message = driverReason
      ? errorMessageForReason(driverReason)
      : 'Credential file did not appear in time. Code may be wrong/expired or PKCE session mismatched.';
    sessions.emitSSE(sessionId, { type: 'error', message });
    return res.status(driverReason ? 409 : 504).json({ error: message });
  }

  session.credentialReady = true;
  emitAuthLog(sessionId, 'success', 'OAuth credential created.');

  // Lưu token vào RTDB ngay khi auth code được xử lý thành công
  try {
    emitAuthLog(sessionId, 'info', `Reading credential file from container & saving token to Firebase RTDB.`);
    const raw = await docker.readCredentialFile(docker.CONFIG.containerName);
    const key = await firebase.saveToken(session.email, raw, sessionId, { verified: false });
    session.tokenSaved = true;
    session.tokenKey = key;
    const tokenSavedEvent = {
      type: 'token_saved',
      email: session.email,
      key,
      verified: false,
      savedAt: Date.now(),
    };
    session.lastTokenSaved = tokenSavedEvent;
    sessions.emitSSE(sessionId, tokenSavedEvent);
    emitAuthLog(sessionId, 'success', `Token saved to Firebase RTDB for ${session.email} (/tokens/${key}).`);
  } catch (saveErr) {
    emitAuthLog(sessionId, 'warning', `Initial save to Firebase RTDB warning: ${saveErr.message}`);
  }

  emitAuthLog(sessionId, 'info', 'Now continuing to AGY verification check flow.');

  if (session.status !== 'verification_required' && session.status !== 'verified' && session.status !== 'success') {
    session.eligibilityStatus = 'checking';
    sessions.updateStatus(sessionId, 'checking_eligibility');
    sessions.emitSSE(sessionId, { type: 'eligibility_result', outcome: 'checking' });
  }

  return res.json({ success: true, stage: session.status, credentialReady: true, tokenSaved: !!session.tokenSaved });
});

// ─── POST /api/login/verify-check ────────────────────────────────────────────

router.post('/verify-check', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  const session = sessions.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'success') return res.json({ success: true, stage: 'success' });

  emitAuthLog(sessionId, 'info', 'Verification requires re-authentication. Cleaning up current session to restart from scratch.');

  if (session.childProcess) {
    try { session.childProcess.kill('SIGTERM'); } catch (_) {}
  }
  await docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
  await docker.resetCredential(docker.CONFIG.containerName).catch(() => {});
  docker.releaseMutex(sessionId);
  sessions.destroySession(sessionId, { reason: 'verify_restart' });

  return res.json({ success: true, needsRestart: true });
});

// ─── POST /api/login/reset ────────────────────────────────────────────────────

router.post('/reset', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  const session = sessions.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.childProcess) {
    try { session.childProcess.kill('SIGTERM'); } catch (_) {}
  }
  await docker.cleanupFifo(docker.CONFIG.containerName, session.fifoPath).catch(() => {});
  await docker.resetCredential(docker.CONFIG.containerName).catch(() => {});
  docker.releaseMutex(sessionId);
  sessions.destroySession(sessionId, { reason: 'reset' });
  return res.json({ success: true });
});

// ─── GET /api/login/session/:sessionId ───────────────────────────────────────
// Kiểm tra phiên còn sống không — để frontend reattach SSE sau khi reload tab.

router.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  const session = sessions.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  return res.json({ success: true, status: session.status, email: session.email });
});

// ─── GET /api/login/status ───────────────────────────────────────────────────
// Trạng thái bận của container — để UI báo "đang bận" thay vì treo.

router.get('/status', (_req, res) => {
  const mutex = docker.getMutexState();
  return res.json({
    success: true,
    busy: !!mutex.holder,
    holder: mutex.holder || null,
    queued: mutex.queued,
    sessions: sessions.listSessions(),
  });
});

// ─── POST /api/login/force-reset ─────────────────────────────────────────────
// Dọn sạch MỌI phiên (kể cả khi đã mất sessionId cũ: reload tab, bỏ qua URL,
// cancel giữa chừng): kill child, xóa FIFO, reset credential, kill driver sót
// trong container, nhả mutex. Xong là chạy lại flow từ đầu được ngay.

router.post('/force-reset', async (req, res) => {
  const { sessionId } = req.body || {};

  const tracked = sessions.listSessions();
  for (const item of tracked) {
    const full = sessions.getSession(item.sessionId);
    if (full && full.childProcess) {
      try { full.childProcess.kill('SIGKILL'); } catch (_) {}
    }
    if (full) {
      await docker.cleanupFifo(docker.CONFIG.containerName, full.fifoPath).catch(() => {});
    }
  }
  sessions.destroyAllSessions({ reason: 'force_reset' });
  await docker.resetCredential(docker.CONFIG.containerName).catch(() => {});
  await docker.killStrayAgy(docker.CONFIG.containerName);
  docker.resetMutex();

  log.ok(`Force reset by ${sessionId || 'unknown'}: cleared ${tracked.length} session(s).`);
  return res.json({ success: true, cleared: tracked.length });
});

module.exports = router;
