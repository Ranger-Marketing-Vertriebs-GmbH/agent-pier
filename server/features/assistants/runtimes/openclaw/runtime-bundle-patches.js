import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Exact edits AgentPier makes to the installed OpenClaw package of one pinned
 * version, until upstream ships the fix. Each names a file under the package root,
 * the text it must contain exactly once and its replacement. Remove a version's
 * entry when the pin moves to a release with the fix; a version without entries is
 * installed unchanged.
 *
 * 2026.11.3, "lease-release-retry": `releaseOpenClawStateLeaseBestEffort`
 * (src/state/openclaw-state-lease-storage.ts) retries a lease release only within
 * `LEASE_CONTENTION_RETRY_TIMEOUT_MS` (2 s, src/state/openclaw-state-lease-heartbeat-
 * shared.ts), while one attempt already waits SQLite's 5 s busy timeout. A release
 * that meets one lock (another writer of the state database holds it for about 5 s,
 * as during an agents.create on a slow disk) is never retried: the plugin lifecycle
 * lease stays held for its 5 minutes and every configuration write waits on it
 * ("config reload failed: database is locked", then `Waiting for plugin lifecycle
 * lease`). The constant is read by that release alone. 30 s ended the wedge in a
 * throttled reproduction (0 of 11 runs against 6 of 16;
 * docs/assistant-release-qualification.md "Lease release patch").
 *
 * 2026.11.3, "codex-catalog-client-version" (and "-setup", the same constant in the
 * openai plugin's setup bundle): ChatGPT-account model discovery asks
 * chatgpt.com/backend-api/codex/models with `client_version`, and the backend lists
 * newer models (GPT-6.2-Astra) only for a recent enough client. The version comes from
 * the Codex plugin (`resolveCodexClientVersion`), which the npm package leaves out and
 * AgentPier never installs, so the bundled fallback `OPENAI_CODEX_CLIENT_VERSION`
 * (extensions/openai/base-url.ts, "0.164.0") is what OpenClaw sends. 0.164.0 does not
 * list GPT-6.2-Astra; 0.169.0 does (checked against a live ChatGPT account).
 *
 * 2026.11.3, "no-restart-resume": OpenClaw's main-session restart recovery
 * (src/agents/main-session-recovery/, started by the Gateway's post-attach startup,
 * by the next visible turn of an interrupted session and by a retried chat.send)
 * asks the model to continue a turn a Gateway restart interrupted ("[System] Your
 * previous turn was interrupted …"). AgentPier never replays interrupted work: its
 * ledger records the turn as interrupted or uncertain for the owner to review
 * (assistant-gateway.md). There is no configuration switch, so the one call that
 * dispatches the resume (`resumeMainSession` in `recoverStore`) settles the turn
 * instead, through upstream's own no-replay path `settleInterruptedRestartRecovery`:
 * status "interrupted", recovery claim and markers cleared, and a local notice
 * appended to the transcript, without a model request or channel delivery. Every
 * step before it stays: orphan marking, settling turns whose reply was delivered,
 * owed delivery notices, tombstones of exhausted recoveries.
 *
 * 2026.11.3, "superseded-publication-retry": after a Doctor migration the first
 * Gateway start prepares every agent once it listens, one after the other (open,
 * migrate, publish its prepared model runtime). `publishAgent` (gateway-prewarm.js)
 * refreshes the agent's model runtime with an `isPublicationCurrent` check and
 * without `joinSupersedingPublication`, so any concurrent refresh (a secrets snapshot
 * activation from `models.authRefresh`, say) makes it throw
 * `PreparedModelRuntimePublicationSupersededError`. The startup loop
 * (src/state/agent-database-startup.ts) retries only its own
 * `AgentDatabaseStartupSupersededError`, so that agent "remains degraded" and its
 * sessions answer UNAVAILABLE until the Gateway restarts; a runtime update then fails
 * its validation and rolls back. The loop retries this refusal too, within its own
 * bound (STARTUP_PUBLICATION_ATTEMPTS, 4). The class is not imported there and sets
 * no `name`, so it is told by its constructor's name, which the bundle keeps
 * (`var PreparedModelRuntimePublicationSupersededError = class …`). AgentPier also
 * no longer causes the refresh while agents are admitted (openclaw-models.js), and a
 * validation that still meets such an agent restarts the Gateway once
 * (runtime-update-validation.js).
 */
export const runtimeBundlePatches = Object.freeze({
  "2026.11.3": Object.freeze([
    Object.freeze({
      id: "lease-release-retry",
      file: "dist/openclaw-state-lease-heartbeat-shared-BczGehzh.mjs",
      before: "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2e3;",
      after: "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 3e4;",
    }),
    // Carry both Codex client version entries forward on a pin bump unless the new
    // version already ships OPENAI_CODEX_CLIENT_VERSION >= 0.169.0; the patch contract
    // and verify-assistant-installation.mjs fail otherwise
    // (tests/helpers/codex-client-version-floor.js).
    Object.freeze({
      id: "codex-catalog-client-version",
      file: "dist/base-url-Baro1bPi.mjs",
      before: 'const OPENAI_CODEX_CLIENT_VERSION = "0.164.0";',
      after: 'const OPENAI_CODEX_CLIENT_VERSION = "0.169.0";',
    }),
    Object.freeze({
      id: "codex-catalog-client-version-setup",
      file: "dist/extensions/openai/.setup/provider-policy-api-BhWaBu5H.mjs",
      before: 'const OPENAI_CODEX_CLIENT_VERSION = "0.164.0";',
      after: 'const OPENAI_CODEX_CLIENT_VERSION = "0.169.0";',
    }),
    // Carry this entry forward on every pin bump until upstream offers a switch that
    // turns automatic resumption off; the patch contract and
    // verify-assistant-installation.mjs fail otherwise
    // (tests/helpers/restart-resume-guard.js). The call's arguments (entry, observation,
    // agentId, sessionKey, storePath) are what the settlement needs; it adds the reason
    // and maps a notice it could not write to "failed", so the sweep retries it.
    Object.freeze({
      id: "no-restart-resume",
      file: "dist/main-session-restart-recovery-DekokRXp.mjs",
      before: "const resumeResult = await resumeMainSession({",
      after:
        "const resumeResult = await (async (resume) => { const settled = await " +
        "settleInterruptedRestartRecovery({ ...resume, reason: " +
        '"AgentPier never resumes an interrupted turn on its own" }); ' +
        'return settled === "notice_failed" ? "failed" : settled; })({',
    }),
    // Carry this entry forward on every pin bump until upstream retries or joins
    // superseded publications in its agent database startup; the patch contract and
    // verify-assistant-installation.mjs fail otherwise
    // (tests/helpers/superseded-publication-guard.js).
    Object.freeze({
      id: "superseded-publication-retry",
      file: "dist/agent-database-startup-DQZqWc4z.mjs",
      before: "!(error instanceof AgentDatabaseStartupSupersededError)",
      after:
        "!(error instanceof AgentDatabaseStartupSupersededError || " +
        'error?.constructor?.name === "PreparedModelRuntimePublicationSupersededError")',
    }),
  ]),
});

// OpenClaw's own record of its files (path, sha256, size); its update and doctor
// checks compare the package with it, so a patched file is recorded as patched.
const contentInventory = "dist/postinstall-content-inventory.json";

const patchFailure = (detail) =>
  Object.assign(Error(`Assistant runtime patch failed: ${detail}.`), {
    code: "RUNTIME_PATCH_MISMATCH",
  });

/** The patches of `version` (an empty list when none). */
export const bundlePatchesFor = (version, patches = runtimeBundlePatches) =>
  patches[version] || [];

/**
 * A short identity of the patches of `version`, or undefined without any. It joins
 * the runtime's identity (runtime-install.js), so an installation made before a
 * patch existed is no longer the shipped one and the update path installs anew.
 */
export function bundlePatchId(version, patches = runtimeBundlePatches) {
  const list = bundlePatchesFor(version, patches);
  if (!list.length) return undefined;
  return createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 12);
}

const count = (text, part) => text.split(part).length - 1;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function packageFile(packageDir, relative) {
  const file = path.join(packageDir, ...relative.split("/"));
  if (!file.startsWith(path.resolve(packageDir) + path.sep))
    throw patchFailure(`unsafe path ${relative}`);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw patchFailure(`${relative} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw patchFailure(`${relative} is not a regular file`);
  return file;
}

// The state of one patch in `text`: "applied", "original", or a mismatch.
function stateOf(text, patch) {
  const before = count(text, patch.before),
    after = count(text, patch.after);
  if (before === 1 && after === 0) return "original";
  if (before === 0 && after === 1) return "applied";
  throw patchFailure(
    `${patch.file} holds the expected text ${before} times and its replacement ${after} times`,
  );
}

// Records `relative`'s new digest and size in OpenClaw's content inventory, when it
// lists the file with the digest of `previous`.
function recordInventory(packageDir, relative, previous, next) {
  const file = path.join(packageDir, ...contentInventory.split("/"));
  if (!fs.existsSync(file)) return;
  const inventory = JSON.parse(
    fs.readFileSync(packageFile(packageDir, contentInventory)),
  );
  const entry = Array.isArray(inventory)
    ? inventory.find((item) => item?.path === relative)
    : null;
  if (!entry) return;
  if (entry.sha256 === sha256(next) && entry.size === next.length) return;
  if (entry.sha256 !== sha256(previous))
    throw patchFailure(`${contentInventory} does not record the original ${relative}`);
  entry.sha256 = sha256(next);
  entry.size = next.length;
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
}

/**
 * Applies the patches of `version` to the installed package at `packageDir`
 * (node_modules/openclaw). Each must find its text exactly once, or its
 * replacement exactly once (already applied); anything else refuses the
 * installation (RUNTIME_PATCH_MISMATCH). Returns the patch identity, or undefined.
 */
export function applyBundlePatches(packageDir, version, patches = runtimeBundlePatches) {
  const list = bundlePatchesFor(version, patches);
  for (const patch of list) {
    const file = packageFile(packageDir, patch.file);
    const bytes = fs.readFileSync(file);
    const text = bytes.toString("utf8");
    if (stateOf(text, patch) === "applied") continue;
    const next = Buffer.from(text.replace(patch.before, patch.after), "utf8");
    fs.writeFileSync(file, next);
    recordInventory(packageDir, patch.file, bytes, next);
  }
  verifyBundlePatches(packageDir, version, patches);
  return bundlePatchId(version, patches);
}

/** Throws unless every patch of `version` is applied at `packageDir`. */
export function verifyBundlePatches(packageDir, version, patches = runtimeBundlePatches) {
  for (const patch of bundlePatchesFor(version, patches)) {
    const text = fs.readFileSync(packageFile(packageDir, patch.file), "utf8");
    if (stateOf(text, patch) !== "applied")
      throw patchFailure(`${patch.file} is not patched`);
  }
}
