#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found. Hãy tạo từ .env.example trước khi deploy.");
  process.exit(1);
}

function parseEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

const env = parseEnvFile(envPath);

function expandEnvReferences(values) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      const next = String(value || "").replace(pattern, (_match, name) => values[name] ?? "");
      if (next !== value) {
        values[key] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

expandEnvReferences(env);

const errors = [];
const warnings = [];
const ok = [];

function isBool(v) {
  return v === "true" || v === "false";
}

function checkPort(key, required = true) {
  const v = env[key];
  if (!v) {
    if (required) errors.push(`${key} is required`);
    else warnings.push(`${key} not set (optional)`);
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`${key} must be an integer in range 1..65535`);
    return;
  }
  ok.push(`${key}=${n}`);
}

function checkRequired(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    errors.push(`${key} is required (${desc})`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK`);
}

function checkOptional(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    warnings.push(`${key} optional: ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK (optional)`);
}

function isValidDomain(v) {
  if (v.startsWith("http://") || v.startsWith("https://")) return "must not include http/https";
  if (v.endsWith("/")) return "must not end with /";
  if (!v.includes(".")) return "must be a valid domain, e.g. example.com";
  return null;
}

function isValidHttpsJsonUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function isValidHttpsOrigin(v) {
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return "must start with https://";
    if (u.pathname !== "/" || u.search || u.hash) {
      return "must be an origin URL only, e.g. https://auth.example.com";
    }
    if (v.endsWith("/")) return "must not end with /";
    return null;
  } catch {
    return "must be a valid https URL";
  }
}

function normalizeDockerEscapedDollar(v) {
  return String(v || "").replace(/\$\$/g, "$");
}

function decodeRcloneConfigBase64(v) {
  const cleaned = String(v || "").replace(/\s/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { error: "must be valid base64" };
  }
  try {
    const config = Buffer.from(cleaned, "base64").toString("utf8");
    const remotes = [...config.matchAll(/^\s*\[([^\]\r\n]+)\]\s*$/gm)].map((match) => match[1].trim());
    if (!remotes.length) return { error: "decoded config must contain at least one [remote] section" };
    return { config, remotes };
  } catch {
    return { error: "must be valid base64" };
  }
}

function parseRcloneRemoteTarget(v) {
  const idx = String(v || "").indexOf(":");
  if (idx <= 0) return { error: "must use <remote_name>:<bucket_or_path> format" };
  return { remote: v.slice(0, idx) };
}

const TINYAUTH_EXAMPLE_BCRYPT_HASH = "$2a$10$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u";

function validateTinyauthUsers(v) {
  if (/(^|[^$])\$(?!\$)/.test(v)) {
    return "bcrypt dollars must be escaped as $$ for Docker Compose";
  }
  const users = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!users.length) return "must contain at least one user";

  for (const entry of users) {
    const parts = entry.split(":");
    const username = (parts[0] || "").trim();
    const hash = normalizeDockerEscapedDollar(parts[1] || "");
    if (!username || parts.length < 2) {
      return "each entry must use username:bcrypt_hash[:totp]";
    }
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
      return "password must be a bcrypt hash, not a plain password";
    }
    if (hash === TINYAUTH_EXAMPLE_BCRYPT_HASH) {
      return "uses the bundled example bcrypt hash; generate a deployment-specific hash";
    }
  }

  return null;
}

function validateTrustedProxies(v) {
  const entries = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length) return "must contain at least one IP/CIDR";

  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split("/");
    if (extra !== undefined || !net.isIP(ip)) {
      return `invalid IP/CIDR entry: ${entry}`;
    }
    if (prefix !== undefined) {
      const n = Number(prefix);
      const max = net.isIP(ip) === 4 ? 32 : 128;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        return `invalid CIDR prefix in entry: ${entry}`;
      }
    }
  }

  return null;
}

function buildAppHost(project, domain) {
  const p = (project || "").trim().toLowerCase();
  const d = (domain || "").trim().toLowerCase();
  if (p && d && (d === p || d.startsWith(`${p}.`))) {
    return domain;
  }
  return `${project}.${domain}`;
}

// 1) Required core env from compose files
checkRequired("PROJECT_NAME", "docker project/network + subdomain prefix", (v) =>
  /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "only lowercase letters, numbers, hyphen",
);
checkRequired("DOMAIN", "root domain", isValidDomain);
checkRequired("CADDY_EMAIL", "caddy email label", (v) => (v.includes("@") ? null : "invalid email"));
checkRequired("TINYAUTH_APP_URL", "public HTTPS Tinyauth URL", isValidHttpsOrigin);
checkPort("TINYAUTH_PORT", true);
checkRequired("TINYAUTH_DB_FILE", "Tinyauth SQLite file", (v) => (v.includes("/") || v.includes("\\") ? "must be a filename, not a path" : null));
// checkRequired("TINYAUTH_USERS", "static users in username:bcrypt_hash format", validateTinyauthUsers);
checkRequired("TINYAUTH_COOKIE_SECURE", "secure cookie toggle", (v) => (isBool(v) ? null : "must be true|false"));
checkRequired("TINYAUTH_TRUSTED_PROXIES", "trusted Caddy/Cloudflared/Tailscale proxy CIDRs", validateTrustedProxies);
checkOptional("TINYAUTH_OAUTH_AUTO_REDIRECT", "none|github|google|generic", (v) =>
  v === "none" || /^[a-z][a-z0-9_-]*$/.test(v) ? null : "must be none or a provider id",
);
checkOptional("TINYAUTH_OAUTH_WHITELIST", "comma-separated OAuth email/domain/regex whitelist");
for (const [name, clientKey, secretKey] of [
  ["Google", "TINYAUTH_GOOGLE_CLIENT_ID", "TINYAUTH_GOOGLE_CLIENT_SECRET"],
  ["GitHub", "TINYAUTH_GITHUB_CLIENT_ID", "TINYAUTH_GITHUB_CLIENT_SECRET"],
  ["Generic", "TINYAUTH_GENERIC_CLIENT_ID", "TINYAUTH_GENERIC_CLIENT_SECRET"],
]) {
  const clientId = (env[clientKey] || "").trim();
  const clientSecret = (env[secretKey] || "").trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) errors.push(`${name} OAuth requires both ${clientKey} and ${secretKey}`);
    else ok.push(`${name} OAuth client/secret=OK (optional)`);
  }
}
for (const key of [
  "TINYAUTH_SECRET",
  "TINYAUTH_DISABLE_CONTINUE",
  "TINYAUTH_TRUST_PROXY",
  "TINYAUTH_ALLOWED_USERS",
  "TINYAUTH_ALLOWED_DOMAINS",
  "TINYAUTH_ALLOWED_GROUPS",
  "TINYAUTH_OIDC_ISSUER",
  "TINYAUTH_OIDC_CLIENT_ID",
  "TINYAUTH_OIDC_CLIENT_SECRET",
  "TINYAUTH_OIDC_SCOPES",
]) {
  if ((env[key] || "").trim()) {
    warnings.push(`${key} is legacy/deprecated for Tinyauth v5 and is not passed to the tinyauth container`);
  }
}
checkPort("APP_PORT", true);

// 1b) AGYCLI_AUTH — agy-cli-auth web app config
checkRequired("AGYCLI_AUTH_CONTAINER_NAME", "name of sibling container hosting `agy` CLI");
checkRequired("AGYCLI_AUTH_AGY_CREDENTIAL_PATH", "path to OAuth token file inside agy-dev container", (v) =>
  v.startsWith("/") ? null : "must be absolute path",
);
checkRequired("AGYCLI_AUTH_AGY_SNAPSHOT_ROOTS", "root dir scanned for snapshot inside agy-dev", (v) =>
  v.startsWith("/") ? null : "must be absolute path",
);
checkRequired("AGYCLI_AUTH_AGY_SNAPSHOT_OUTPUT_DIR", "snapshot output dir inside app container", (v) =>
  v.startsWith("/") ? null : "must be absolute path",
);
checkOptional("AGYCLI_AUTH_AGY_SNAPSHOT_COPY_LIMIT", "max files copied per snapshot", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("AGYCLI_AUTH_AGY_SNAPSHOT_MAX_FILE_BYTES", "max bytes per snapshotted file", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("AGYCLI_AUTH_SESSION_TIMEOUT_MS", "auto-cleanup timeout per login session (ms)", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 60000 ? null : "must be integer >= 60000";
});
checkOptional("AGYCLI_AUTH_VERIFICATION_SESSION_TIMEOUT_MS", "auto-cleanup timeout while waiting for account verification (ms)", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 60000 ? null : "must be integer >= 60000";
});
checkOptional("AGYCLI_AUTH_AGY_EXPECTED_VERSION", "optional tested AGY version guard", (v) =>
  /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v) ? null : "must look like 1.1.7 or v1.1.7",
);
checkOptional("AGYCLI_AUTH_AGY_AUTO_UPDATE", "auto-update agy to latest on container start", (v) =>
  v === "0" || v === "1" ? null : "must be 0 or 1",
);
checkOptional("AGYCLI_AUTH_AGY_UPDATE_INTERVAL_SEC", "re-check agy version every N seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? null : "must be integer >= 0";
});
checkOptional("AGYCLI_AUTH_AGY_LOGIN_FLOW_TIMEOUT_SEC", "overall PTY auth/eligibility flow timeout (seconds)", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC", "max wait for positive eligibility probe response (seconds)", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 10 ? null : "must be integer >= 10";
});
checkOptional("AGYCLI_AUTH_AGY_CREDENTIAL_CHECK_TIMEOUT_MS", "wait for OAuth credential file after code submit (ms)", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 5000 ? null : "must be integer >= 5000";
});

// Firebase: either BASE64 must be set OR a valid host JSON file must exist.
{
  const fbBase64 = (env.AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64 || "").trim();
  const fbHostPath = (env.AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH || "").trim();
  if (!fbBase64) {
    if (!fbHostPath) {
      errors.push("Firebase: set either AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64 or AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH");
    } else {
      const resolved = path.resolve(process.cwd(), fbHostPath);
      if (!fs.existsSync(resolved)) {
        errors.push(`Firebase service account file not found at ${fbHostPath} (resolved: ${resolved}). Place the JSON or set AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64 instead.`);
      } else {
        ok.push("AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_HOST_PATH=present");
      }
    }
  } else {
    ok.push("AGYCLI_AUTH_FIREBASE_SERVICE_ACCOUNT_BASE64=present");
  }
}
checkOptional("AGYCLI_AUTH_FIREBASE_PROJECT_ID", "Firebase project ID fallback when JSON has no project_id");
checkOptional("AGYCLI_AUTH_FIREBASE_DATABASE_URL", "Firebase RTDB URL fallback when JSON has no databaseURL", (v) =>
  v.startsWith("https://") ? null : "must start with https://",
);

// 2) Optional env from compose files
checkPort("APP_HOST_PORT", false);
checkPort("DOZZLE_HOST_PORT", false);
checkPort("FILEBROWSER_HOST_PORT", false);
checkPort("WEBSSH_HOST_PORT", false);
checkOptional("NODE_ENV", "app runtime env");
checkOptional("HEALTH_PATH", "health endpoint path", (v) => (v.startsWith("/") ? null : "must start with '/'"));
checkOptional("DOCKER_SOCK", "docker socket path override");
checkPort("DOCKER_DEPLOY_CODE_PORT", false);
checkPort("DOCKER_DEPLOY_CODE_HOST_PORT", false);
checkOptional("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public Caddy host for deploy-code UI/API");
checkOptional("DOCKER_DEPLOY_CODE_REPO_DIR", "repo path mounted inside deploy-code sidecar");
checkOptional("DOCKER_DEPLOY_CODE_BRANCH", "git branch to deploy");
checkOptional("DOCKER_DEPLOY_CODE_REMOTE", "git remote to fetch");
checkOptional("DOCKER_DEPLOY_CODE_COMPOSE_SCRIPT", "compose orchestration script inside repo");
checkOptional("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "comma-separated compose services to rebuild/redeploy");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED", "true|false toggle for container control API", (v) =>
  isBool(v) ? null : "must be true|false",
);
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL", "true|false toggle to allow all Docker containers", (v) =>
  isBool(v) ? null : "must be true|false",
);
checkOptional("DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST", "comma-separated compose services allowed for start/stop/restart/rebuild/logs");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST", "comma-separated containers allowed for start/stop/restart/logs/inspect");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_DEFAULT_LINES", "default container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_MAX_LINES", "max container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ACTION_TIMEOUT_SEC", "Docker action timeout seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_POLL_INTERVAL_SEC", "git polling interval seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_ZIP_MAX_MB", "max raw ZIP upload size in MB", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});

if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  checkRequired("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "service(s) deploy-code may rebuild/redeploy");
  checkRequired("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public deploy-code hostname for Caddy");

  const requireToken = (env.DOCKER_DEPLOY_CODE_REQUIRE_TOKEN || "true").trim();
  if (!isBool(requireToken)) {
    errors.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN must be true|false");
  } else if (requireToken === "true") {
    checkRequired("DOCKER_DEPLOY_CODE_API_TOKEN", "required when deploy-code token auth is enabled", (v) =>
      v.length >= 16 ? null : "must be at least 16 characters",
    );
  } else {
    warnings.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=false while deploy-code is enabled -> rely on Tinyauth / private network only");
  }
}

// 3) Flags
for (const key of [
  "ENABLE_DOZZLE",
  "ENABLE_FILEBROWSER",
  "ENABLE_WEBSSH",
  "ENABLE_TAILSCALE",
  "ENABLE_LITESTREAM",
  "ENABLE_RCLONE",
  "DOCKER_DEPLOY_CODE_ENABLED",
  "DOCKER_DEPLOY_CODE_POLL_ENABLED",
  "DOCKER_DEPLOY_CODE_AUTO_DEPLOY_ON_CHANGE",
  "DOCKER_DEPLOY_CODE_RUN_ON_START",
  "DOCKER_DEPLOY_CODE_REQUIRE_TOKEN",
  "DOCKER_DEPLOY_CODE_GIT_CLEAN",
  "DOCKER_DEPLOY_CODE_ZIP_STRIP_TOP_LEVEL",
  "DOCKER_DEPLOY_CODE_ZIP_DELETE_MISSING",
  "DOCKER_DEPLOY_CODE_ZIP_BACKUP_BEFORE_APPLY",
  "DOCKER_DEPLOY_CODE_ZIP_DEPLOY_AFTER_APPLY",
]) {
  const v = env[key];
  if (!v) {
    warnings.push(`${key} not set -> using default from scripts/compose`);
    continue;
  }
  if (!isBool(v)) errors.push(`${key} must be true|false`);
  else ok.push(`${key}=${v}`);
}

if ((env.ENABLE_RCLONE || "false") === "true") {
  checkRequired("RCLONE_CONFIG_BASE64", "base64-encoded rclone.conf", (v) => decodeRcloneConfigBase64(v).error || null);
  checkRequired("RCLONE_REMOTE_TARGET", "<remote_name>:<bucket_or_path>", (v) => parseRcloneRemoteTarget(v).error || null);

  const config = decodeRcloneConfigBase64(env.RCLONE_CONFIG_BASE64);
  const target = parseRcloneRemoteTarget(env.RCLONE_REMOTE_TARGET);
  if (!config.error && !target.error) {
    if (!config.remotes.includes(target.remote)) {
      errors.push(`RCLONE_REMOTE_TARGET remote "${target.remote}" not found in decoded rclone.conf sections: ${config.remotes.join(", ")}`);
    } else {
      ok.push(`RCLONE_REMOTE_TARGET remote=${target.remote}`);
    }
  }
}

if ((env.ENABLE_LITESTREAM || "true") === "true") {
  const initMode = (env.LITESTREAM_INIT_MODE || "").trim();
  if (!isBool(initMode)) errors.push("LITESTREAM_INIT_MODE must be true|false");
  checkRequired("LITESTREAM_REPLICATE_DBS", "comma-separated SQLite DB ids, e.g. tinyauth or tinyauth,app");
  checkRequired("LITESTREAM_S3_ENDPOINT", "S3-compatible endpoint", (v) =>
    v.startsWith("http://") || v.startsWith("https://") ? null : "must start with http:// or https://",
  );
  checkRequired("LITESTREAM_S3_BUCKET", "S3 bucket");
  checkRequired("LITESTREAM_S3_ACCESS_KEY_ID", "S3 access key id");
  checkRequired("LITESTREAM_S3_SECRET_ACCESS_KEY", "S3 secret access key");
  checkRequired("LITESTREAM_TINYAUTH_S3_PATH", "Tinyauth replica path");
  checkOptional("LITESTREAM_APP_DB_FILE", "optional app SQLite filename");
  checkOptional("LITESTREAM_APP_S3_PATH", "optional app replica path");
  checkRequired("LITESTREAM_SYNC_INTERVAL", "Litestream sync interval");
  checkRequired("LITESTREAM_SNAPSHOT_INTERVAL", "Litestream snapshot interval");
  checkRequired("LITESTREAM_RETENTION", "Litestream retention");
  checkRequired("LITESTREAM_RETENTION_CHECK_INTERVAL", "Litestream retention check interval");
}

// 4) Files required by cloudflared mounts
const cfConfig = path.resolve(process.cwd(), "cloudflared/config.yml");
const cfCreds = path.resolve(process.cwd(), "cloudflared/credentials.json");
if (!fs.existsSync(cfConfig)) errors.push("cloudflared/config.yml missing (cloudflared mount required)");
else ok.push("cloudflared/config.yml present");
if (!fs.existsSync(cfCreds)) errors.push("cloudflared/credentials.json missing (cloudflared mount required)");
else ok.push("cloudflared/credentials.json present");

// 5) Optional webssh runtime tuning vars
if ((env.ENABLE_WEBSSH || "true") === "true") {
  if (!env.CUR_WHOAMI) warnings.push("CUR_WHOAMI optional (webssh linux default runner)");
  if (!env.CUR_WORK_DIR) warnings.push("CUR_WORK_DIR optional (webssh linux default /home/runner)");
  if (!env.SHELL) warnings.push("SHELL optional (webssh linux default /bin/bash)");
}

// 6) Tailscale + keep-ip rules based on compose.access.yml
if (env.ENABLE_TAILSCALE === "true") {
  checkRequired("TAILSCALE_AUTHKEY", "required by tailscale service", (v) => (v.startsWith("tskey-") ? null : "must start with tskey-"));
  checkRequired("TAILSCALE_TAILNET_DOMAIN", "required by dc.sh to render tailscale/serve.json", (v) =>
    v && v !== "-" ? null : "must not be empty or '-'",
  );
  checkOptional("TAILSCALE_TAGS", "advertise tags", (v) =>
    /^tag:[A-Za-z0-9][A-Za-z0-9_-]*(,tag:[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(v) ? null : "format must be tag:a,tag:b",
  );

  const keepIp = (env.TAILSCALE_KEEP_IP_ENABLE || "false").trim();
  if (!isBool(keepIp)) errors.push("TAILSCALE_KEEP_IP_ENABLE must be true|false");

  const keepRemove = (env.TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE || "").trim();
  if (keepRemove && !isBool(keepRemove)) {
    errors.push("TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE must be true|false when provided");
  }

  if (keepIp === "true") {
    checkRequired("TAILSCALE_KEEP_IP_FIREBASE_URL", "required when keep-ip enabled", (v) =>
      isValidHttpsJsonUrl(v) ? null : "must be https URL ending with .json",
    );
    checkOptional("TAILSCALE_KEEP_IP_CERTS_DIR", "certs dir path");
    checkOptional("TAILSCALE_KEEP_IP_INTERVAL_SEC", "backup interval seconds", (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
    });
  } else {
    warnings.push("TAILSCALE_KEEP_IP_ENABLE=false -> keep-ip backup/restore disabled");
  }

  const removeHostnameEnabled = keepRemove ? keepRemove === "true" : keepIp === "true";
  if (removeHostnameEnabled) {
    if (!env.TAILSCALE_CLIENTID) {
      errors.push("remove-hostname enabled requires TAILSCALE_CLIENTID");
    }
    const authKey = (env.TAILSCALE_AUTHKEY || "").trim();
    if (!authKey) {
      errors.push("remove-hostname enabled requires TAILSCALE_AUTHKEY");
    } else if (!authKey.startsWith("tskey-client-")) {
      errors.push("remove-hostname requires TAILSCALE_AUTHKEY in tskey-client-* format");
    }
  }
}

const project = env.PROJECT_NAME || "<project>";
const domain = env.DOMAIN || "<domain>";
const host = env.PROJECT_NAME || "myapp";
const tailnet = env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local";
const appHost = buildAppHost(project, domain);
ok.push(`subdomain preview: app=${appHost}`);
if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`subdomain preview: logs=logs.${appHost}`);
if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`subdomain preview: files=files.${appHost}`);
if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`subdomain preview: ttyd=ttyd.${appHost}`);
if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  ok.push(`subdomain preview: deploy-code=${env.DOCKER_DEPLOY_CODE_CADDY_HOSTS || `deploy.${domain}`}`);
}
if (env.ENABLE_TAILSCALE === "true") {
  const dozzlePort = env.DOZZLE_HOST_PORT || "18080";
  const filesPort = env.FILEBROWSER_HOST_PORT || "18081";
  const sshPort = env.WEBSSH_HOST_PORT || "17681";
  const deployCodePort = env.DOCKER_DEPLOY_CODE_HOST_PORT || "15399";
  ok.push(`tailnet host: https://${host}.${tailnet}`);
  if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`tailnet dozzle: http://${host}.${tailnet}:${dozzlePort}`);
  if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`tailnet filebrowser: http://${host}.${tailnet}:${filesPort}`);
  if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`tailnet webssh: http://${host}.${tailnet}:${sshPort}`);
  if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") ok.push(`tailnet deploy-code: http://${host}.${tailnet}:${deployCodePort}`);
}

console.log("\n📋 ENV VALIDATION REPORT");
console.log("─".repeat(60));

if (ok.length) {
  console.log(`\n✅ Valid (${ok.length})`);
  for (const s of ok) console.log(`  - ${s}`);
}
if (warnings.length) {
  console.log(`\n⚠️ Warnings (${warnings.length})`);
  for (const s of warnings) console.log(`  - ${s}`);
}
if (errors.length) {
  console.log(`\n❌ Errors (${errors.length})`);
  for (const s of errors) console.log(`  - ${s}`);
  console.log("\nDừng triển khai. Hãy sửa lỗi bắt buộc trước khi chạy up.\n");
  process.exit(1);
}

console.log("\n✅ Env hợp lệ. Có thể triển khai.\n");
