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
    // Storage integrity checks while services start.
    "server/features/pipelines/run-store.js": [
      "Unsafe pipeline storage.",
      "Unsafe pipeline database.",
    ],
    "server/features/providers/provider-connections.js": [
      "Unsafe provider connection storage.",
      "Unsafe provider connection directory.",
      "Invalid provider connection storage.",
    ],
    // Machine token; the browser maps it to its own copy.
    "server/features/repositories/commit-identity.js": ["INVALID_COMMIT_IDENTITY"],
    // Only MCP machine tokens receive this answer.
    "server/http/security.js": ["Machine tokens are accepted only at the MCP endpoint."],
    // Stdio helper for coding agents; its usage and German hints go to the terminal.
    "server/ssh.mjs": [
      "Usage: ssh.mjs --data-dir DIR --session ID --access ID [-- remote command]",
      "SSH-Zugang wurde geändert. Bitte erneut versuchen.",
    ],
  }),
);

const literal = /\bproblem\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

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
  for (const file of await sources(server)) {
    const text = await readFile(file, "utf8");
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const match of text.matchAll(literal)) {
      const message = match[2].replace(/\s+/g, " ");
      const allowed = untranslated.get(relative) ?? [];
      assert.ok(
        allowed.includes(message),
        `${relative}: move "${message}" into server/lib/i18n or allowlist it`,
      );
      found.set(relative, new Set([...(found.get(relative) ?? []), message]));
    }
  }
  // Stale entries would hide a later regression at the same text.
  for (const [file, messages] of untranslated)
    for (const message of messages)
      assert.ok(
        found.get(file)?.has(message),
        `stale allowlist entry ${file}: ${message}`,
      );
});
