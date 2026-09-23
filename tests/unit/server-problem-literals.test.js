import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const server = path.join(root, "server");

// Literal problem texts that never reach the browser, so they stay untranslated.
// Every entry names the file and the exact text; remove it when the site changes.
const untranslated = new Map(
  Object.entries({
    // Remote MCP HTTP transport: answers MCP clients, not the AgentPier UI.
    "server/features/mcp/http-transport.js": [
      "Proxy requests require the configured remote host.",
      "MCP requires the local, Tailscale or configured network host.",
      "MCP host is not allowed.",
      "MCP origin is not allowed.",
      "Cross-site MCP requests are not allowed.",
      "Artifact session access is unavailable.",
    ],
    // MCP tool errors return to the coding agent through JSON-RPC.
    "server/features/mcp/session-capability.js": [
      "Invalid AgentPier session capability.",
      "Unsafe AgentPier session capability storage.",
      "AgentPier access expired, revoked or session unavailable. Reload the session to renew an expired grant.",
    ],
    "server/features/mcp/start-requests.js": [
      "This request ID was already used for a different start.",
      "The durable MCP start registry has reached its capacity.",
    ],
    "server/features/mcp/tool-policy.js": [
      "This MCP grant does not allow that action.",
      "This resource is outside the MCP grant.",
      "The frozen source account does not match its profile.",
      "The frozen provider connection does not match its profile.",
      "This session did not start that run.",
      "Tool output exceeds its limit. Request a smaller page or individual item.",
      "Tool metadata exceeds its response limit.",
    ],
    "server/features/mcp/tool-service.js": [
      "Unknown MCP tool.",
      "Invalid MCP tool arguments. Check the tool input schema.",
      "This start was interrupted before a run could be confirmed. Inspect AgentPier before submitting a new request ID.",
      "The registered project identity changed. Register and authorize the current project before starting a run.",
      "The provider connection does not support that CLI.",
      "No account for this CLI is authorized.",
      "This grant did not start that run.",
    ],
    "server/features/ssh/ssh-capability.js": [
      "SSH capability unavailable.",
      "SSH capability revoked or session unavailable.",
    ],
    "server/features/ssh/ssh-execution-lock.js": [
      "An SSH command is already running for this session.",
    ],
    "server/features/ssh/ssh-tools.js": [
      "SSH transport is closing.",
      "Invalid SSH arguments.",
      "Unknown SSH tool.",
      "Invalid SSH command or timeout.",
      "SSH assignment or capability revoked.",
      "SSH command could not start.",
    ],
    // SSH management tools: only the session's ssh helper calls perform() and respond().
    "server/features/ssh/ssh-management.js": [
      "Invalid SSH request.",
      "Unknown SSH management tool.",
      "Invalid SSH tool arguments.",
      "Invalid SSH key page.",
      "SSH host is not assigned.",
      "SSH connection test failed.",
      "SSH key is invalid or encrypted.",
      "The saved endpoint uses a different key or host pin. Change it in the UI.",
    ],
    "server/features/ssh/ssh-management-client.js": [
      "SSH management unavailable. Retry with the same request ID after reconnecting.",
      "SSH request is too large.",
    ],
    "server/features/ssh/ssh-management-records.js": [
      "SSH key is not owned by this project.",
      "An independently verified host identity is required.",
      "Bootstrap access is not assigned to this session.",
      "The host key does not match the assigned pinned endpoint.",
    ],
    "server/features/ssh/ssh-receipts.js": [
      "A bounded request ID is required.",
      "Request ID was already used with different arguments.",
      "The original request resource was deleted or moved.",
      "The original connection was changed in the UI.",
    ],
    "server/features/ssh/ssh-import.js": [
      "SSH import source is unavailable or unsupported.",
    ],
    // Memory MCP tools and their capability check answer the coding agent only.
    "server/features/memory/memory-tools.js": [
      "Unknown memory tool.",
      "Invalid memory tool arguments.",
    ],
    "server/features/memory/memory-capability.js": [
      "Memory access was revoked or is unavailable.",
    ],
    // Constructor invariant for the configured data directory.
    "server/features/sessions/session-manager.js": ["Invalid data directory"],
    // Internal invariant, never raised by a request.
    "server/features/ssh/ssh-catalog.js": [
      "SSH catalog mutation requires a transaction.",
    ],
    // Server-internal notification kinds; browser input never reaches this check.
    "server/features/notifications/push-validation.js": ["Invalid notification kind."],
    // Release packaging and runtime preparation run in operator build scripts.
    "server/features/operations/release-archive.js": [
      "Release payload exceeds its limit.",
      "Release payload link escapes its source.",
      "Release payload contains a directory cycle.",
    ],
    "server/features/operations/release-runtime.js": [
      "Unsupported release runtime platform.",
      "Official Node checksum is missing.",
      "Official Node runtime checksum mismatch.",
      "Official Node runtime license is missing.",
      "Invalid extracted Node runtime.",
    ],
    // Only MCP machine tokens receive this answer.
    "server/http/security.js": ["Machine tokens are accepted only at the MCP endpoint."],
    // Stdio helper for coding agents; its usage and German hints go to the terminal.
    "server/ssh.mjs": [
      "Usage: ssh.mjs --data-dir DIR --session ID --access ID [-- remote command]",
      "SSH-Zugang wurde geändert. Bitte erneut versuchen.",
    ],
  }),
);

// Helpers that turn a message into a status-bearing problem. Every string literal in
// their arguments counts, including ternary branches; bare codes like SSH_BUSY do not.
const helper = /\b(?:problem|failure|fail|bad|migrateError|cleanupError|\w+Problem)\(/g;
const literal = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function argumentsOf(text, start) {
  let depth = 1;
  let quote = null;
  let index = start;
  for (; index < text.length && depth; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
  }
  return text.slice(start, index - 1);
}

function messages(text) {
  const found = [];
  for (const call of text.matchAll(helper))
    for (const match of argumentsOf(text, call.index + call[0].length).matchAll(
      literal,
    )) {
      const message = match[2].replace(/\s+/g, " ");
      if (/[a-z]/.test(message) && /\s|\.$/.test(message)) found.push(message);
    }
  return found;
}

async function sources(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (file !== path.join(server, "lib", "i18n")) files.push(...(await sources(file)));
    } else if (/\.m?js$/.test(entry.name)) files.push(file);
  }
  return files;
}

test("browser-visible server problems use catalog messages instead of literals", async () => {
  const found = new Map();
  const unexpected = [];
  for (const file of await sources(server)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const allowed = untranslated.get(relative) ?? [];
    for (const message of messages(await readFile(file, "utf8"))) {
      if (!allowed.includes(message)) unexpected.push(`${relative}: ${message}`);
      found.set(relative, new Set([...(found.get(relative) ?? []), message]));
    }
  }
  // Move these into server/lib/i18n, or allowlist text that never reaches a browser.
  assert.deepEqual(unexpected, []);
  // Stale entries would hide a later regression at the same text.
  const stale = [...untranslated].flatMap(([file, texts]) =>
    texts.filter((text) => !found.get(file)?.has(text)).map((text) => `${file}: ${text}`),
  );
  assert.deepEqual(stale, []);
});
