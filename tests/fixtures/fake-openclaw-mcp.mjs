// A stand-in for `openclaw mcp login|status|logout` that prints the outputs recorded
// in docs/mcp-oauth-qualification.md. FAKE_OPENCLAW_MODE picks the behaviour
// (FAKE_OPENCLAW_STATE overrides the printed login state);
// FAKE_OPENCLAW_RECORD, when set, receives the argv, environment and pid as JSON.
import fs from "node:fs";
import { spawn } from "node:child_process";

const [, , group, command, name, ...rest] = process.argv;
const mode = process.env.FAKE_OPENCLAW_MODE || "ok";
if (process.env.FAKE_OPENCLAW_RECORD)
  fs.writeFileSync(
    process.env.FAKE_OPENCLAW_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: process.env,
      pid: process.pid,
      ...(fs.existsSync(process.env.OPENCLAW_CONFIG_PATH || "")
        ? {
            configMode: fs.statSync(process.env.OPENCLAW_CONFIG_PATH).mode,
            configDirMode: fs.statSync(
              process.env.OPENCLAW_CONFIG_PATH.replace(/\/[^/]+$/, ""),
            ).mode,
          }
        : {}),
      config: fs.existsSync(process.env.OPENCLAW_CONFIG_PATH || "")
        ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"))
        : null,
    }),
  );

// FAKE_OPENCLAW_LOG, when set, gets one JSON line per call: the arguments after `mcp`.
if (process.env.FAKE_OPENCLAW_LOG)
  fs.appendFileSync(
    process.env.FAKE_OPENCLAW_LOG,
    `${JSON.stringify(process.argv.slice(3))}\n`,
  );

const state = process.env.FAKE_OPENCLAW_STATE || "3f2b8c1e-4d5a-4f6b-9c7d-8e9f0a1b2c3d";
const url =
  "http://127.0.0.1:41234/authorize?response_type=code&client_id=client-1" +
  "&code_challenge=Zx9w8v7u6t5s4r3q2p1o0nMLKJIHGFEDCBA_abcdefg&code_challenge_method=S256" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A4380%2Fapi%2Fmcp-servers%2Foauth%2Fcallback" +
  `&state=${state}&resource=http%3A%2F%2F127.0.0.1%3A41234%2Fmcp`;

const out = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

const authStatus = {
  unauthenticated: {
    hasTokens: false,
    requiresAuthorization: false,
    hasClientInformation: false,
    hasCodeVerifier: false,
    hasDiscoveryState: false,
    hasLastAuthorizationUrl: false,
    state: "unauthenticated",
  },
  pending: {
    hasTokens: false,
    requiresAuthorization: false,
    hasClientInformation: true,
    hasCodeVerifier: true,
    hasDiscoveryState: true,
    hasLastAuthorizationUrl: true,
    state: "pending-authorization",
  },
  authorized: {
    hasTokens: true,
    requiresAuthorization: false,
    hasClientInformation: true,
    hasCodeVerifier: false,
    hasDiscoveryState: true,
    hasLastAuthorizationUrl: false,
    state: "authorized",
    expiresAt: 1791234567890,
  },
  revoked: {
    hasTokens: false,
    requiresAuthorization: false,
    hasClientInformation: true,
    hasCodeVerifier: false,
    hasDiscoveryState: true,
    hasLastAuthorizationUrl: false,
    state: "pending-authorization",
  },
  refused: {
    hasTokens: true,
    requiresAuthorization: true,
    hasClientInformation: true,
    hasCodeVerifier: false,
    hasDiscoveryState: true,
    hasLastAuthorizationUrl: false,
    state: "requires-authorization",
  },
};
const row = (serverName, auth) => ({
  name: serverName,
  configured: true,
  enabled: true,
  ok: true,
  transport: "streamable-http",
  launch: "http://127.0.0.1:41234/mcp",
  requestTimeoutMs: 60000,
  connectionTimeoutMs: 30000,
  supportsParallelToolCalls: false,
  ...(auth ? { auth: "oauth", authStatus: authStatus[auth] } : {}),
});

// OpenClaw 2026.9.8's output when a write transaction meets a writer: `lockedAt`
// names the transaction (`operation`, `step`) and the reason OpenClaw reports.
const lockedAt = (operation, step, reason = "database is locked") =>
  [
    `[sqlite/transaction] SQLite transaction lock wait failed async=false busyTimeoutMs=0 operation=${operation} code=ERR_SQLITE_ERROR elapsedMs=0 failureKind=lock-contention sqliteErrcode=5 step=${step}`,
    "[openclaw] The CLI command failed.",
    `[openclaw] Reason: ${reason}`,
    "[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.",
    "[openclaw] Try: openclaw doctor",
    "[openclaw] Help: openclaw --help",
  ].join("\n");
const lockOutputs = {
  // The lease's own transaction could not start: nothing was done.
  locked: lockedAt("state.lease", "begin"),
  "lease-busy": [
    "[openclaw] The CLI command failed.",
    "[openclaw] Reason: failed to acquire state lease core:mcp-oauth/docs-1e3e0b7c5d771873: store unavailable (sqlite-busy)",
  ].join("\n"),
  // A store write under the lease, possibly after the code exchange.
  "locked-store": lockedAt("mcp.oauth.store", "begin"),
  // The operation failed and the lease's release met the lock too.
  "locked-cleanup": lockedAt(
    "state.lease",
    "begin",
    "State lease operation and cleanup failed",
  ),
};
// "locked-once": the first call meets the lease lock (FAKE_OPENCLAW_RECORD marks it),
// later calls run as "ok".
let effective = mode;
if (mode === "locked-once") {
  if (!process.env.FAKE_OPENCLAW_RECORD) fail("locked-once needs FAKE_OPENCLAW_RECORD");
  const marker = `${process.env.FAKE_OPENCLAW_RECORD}.locked`;
  if (fs.existsSync(marker)) effective = "ok";
  else {
    fs.writeFileSync(marker, "1");
    effective = "locked";
  }
}

// OpenClaw's console redaction masks a challenge that looks like a key (recorded in
// CI): "redacted" as `<6>…<4>`, "redacted-stars" ending in `***`; "redacted-once"
// masks only the first login (FAKE_OPENCLAW_RECORD marks it), later ones print as "ok".
const challenge = "Zx9w8v7u6t5s4r3q2p1o0nMLKJIHGFEDCBA_abcdefg";
const masked = {
  redacted: `${challenge.slice(0, 6)}\u2026${challenge.slice(-4)}`,
  "redacted-stars": `${challenge.slice(0, 27)}***`,
};
if (mode === "redacted-once") {
  if (!process.env.FAKE_OPENCLAW_RECORD) fail("redacted-once needs FAKE_OPENCLAW_RECORD");
  const marker = `${process.env.FAKE_OPENCLAW_RECORD}.redacted`;
  if (fs.existsSync(marker)) effective = "ok";
  else {
    fs.writeFileSync(marker, "1");
    effective = "redacted";
  }
}
const printedUrl = masked[effective] ? url.replace(challenge, masked[effective]) : url;

if (group !== "mcp") fail(`unexpected ${group}`);
if (lockOutputs[effective]) fail(lockOutputs[effective]);
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "hang-group") {
  // A grandchild in the CLI's process group, recorded next to the CLI's own pid.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(`${process.env.FAKE_OPENCLAW_RECORD}.child`, String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === "fail-url")
  fail(
    "Error: request to http://127.0.0.1:41234/authorize?redirect_uri=x failed: ECONNREFUSED",
  );
else if (mode === "flood") out("x".repeat(1024 * 1024));
else if (mode === "fail-generic")
  fail(`Error: something broke for ${rest.join(" ")} Bearer abc.def.ghi`);
else if (mode === "fail-dcr")
  fail("Reason: Incompatible auth server: does not support dynamic client registration");
else if (mode === "fail-redirect")
  fail(
    'Reason: Dynamic client registration failed: invalid_client_metadata "redirect_uri"',
  );
else if (mode === "fail-session")
  fail("Reason: Missing MCP OAuth authorization session. Run the login flow again.");
else if (mode === "fail-unknown")
  fail(`No MCP server named "${name}" in /tmp/openclaw.json. Run openclaw mcp list.`);
else if (command === "status") {
  out(
    JSON.stringify(
      {
        path: process.env.OPENCLAW_CONFIG_PATH,
        servers: [
          row("fresh", "unauthenticated"),
          row("pending", "pending"),
          // "code-fails-unsaved": a --code that failed before OpenClaw saved tokens.
          row("docs", mode === "code-fails-unsaved" ? "pending" : "authorized"),
          row("revoked", "revoked"),
          row("refused", "refused"),
          row("plain"),
        ],
      },
      null,
      2,
    ),
  );
} else if (command === "logout") out(`MCP OAuth credentials cleared for "${name}".`);
else if (command === "login" && rest.some((a) => a.startsWith("--code"))) {
  // "code-fails": the CLI fails after saving the tokens (status reads authorized).
  if (mode === "code-fails" || mode === "code-fails-unsaved")
    fail(lockedAt("state.lease", "commit"));
  out(`MCP OAuth credentials saved for "${name}".`);
} else if (command === "login" && mode === "refresh")
  out(`MCP OAuth credentials saved for "${name}".`);
else if (command === "login") {
  out(
    mode === "https"
      ? "Could not start the local OAuth callback (OAuth callback redirect must use HTTP on a loopback address)."
      : "Could not start the local OAuth callback (listen EADDRINUSE: address already in use 127.0.0.1:4380).",
  );
  out(`Open this URL to authorize "${name}":`);
  if (mode !== "no-url")
    out(mode === "no-state" ? url.replace(/&state=[^&]+/, "") : printedUrl);
  out(`After approval, run openclaw mcp login ${name} --code <code>.`);
} else fail(`unexpected ${command}`);
