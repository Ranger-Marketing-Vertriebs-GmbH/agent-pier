import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Exact edits AgentPier makes to the installed OpenClaw package of one pinned
 * version, until upstream ships the fix. Each names a file under the package root,
 * the text it must contain exactly once and its replacement. Remove a version's
 * entry when the pin moves to a release with the fix; a version without entries is
 * installed unchanged. The rollback target keeps the patches it was installed with:
 * its installation is never patched again, and one whose version has no entries
 * here starts without a check of them (runtime-install.js).
 *
 * 2026.11.6, "lease-release-retry": `releaseOpenClawStateLeaseBestEffort`
 * (src/state/openclaw-state-lease-storage.ts) retries a lease release that met a
 * SQLite lock only until `OPENCLAW_SQLITE_BUSY_TIMEOUT_MS` (5 s) after its first
 * attempt (2026.11.3: `LEASE_CONTENTION_RETRY_TIMEOUT_MS`, 2 s). A release that meets
 * one lock held for about 5 s (another writer of the state database, as during an
 * agents.create on a slow disk) is then retried hardly or not at all: the plugin
 * lifecycle lease stays held for its 5 minutes and every configuration write waits on
 * it ("config reload failed: database is locked", then `Waiting for plugin lifecycle
 * lease`). The patch gives the lock case 30 s, in the release alone; the shared
 * `LEASE_CONTENTION_RETRY_TIMEOUT_MS`, which 2026.11.6 also reads in the agent
 * execution, stays as shipped. 30 s ended the wedge in a throttled reproduction on
 * 2026.11.3 (0 of 11 runs against 6 of 16; docs/assistant-release-qualification.md
 * "Lease release patch").
 *
 * 2026.11.6, "no-restart-resume" (and "-inputs"): OpenClaw marks the sessions that
 * were working when the Gateway shut down (`persistRunningSessionsForRestart`) and,
 * after the next start, sends each one "The Gateway restarted while you were
 * working. Resume your work: …" and replays the user messages queued behind it
 * (`resumeMarkedSessions`, src/gateway/session-restart-resume.ts). It also adopts a
 * 2026.11.3 main-session recovery marker less than six hours old the same way.
 * AgentPier never replays interrupted work: its ledger records the turn as
 * interrupted or uncertain for the owner to review (assistant-gateway.md). There is
 * no configuration switch, so the startup pass adopts no marker: it still clears
 * every marker (`resumeAfterRestart`, `mainRestartRecovery`) but admits no resume
 * input, and the queued messages a marker reserved are withdrawn with every other
 * orphaned input of the previous Gateway instead of being sent again.
 *
 * 2026.11.6, "hydrated-tools-kept" (and "-list"): with tool search in directory mode a
 * model may call a directory tool by name; the run hydrates it into the turn's tool
 * list (agent-core `resolveToolCallTool`). The next turn's context then starts again
 * from the session's tools (`createSessionPrepareNextTurnWithContext`), so the
 * hydrated tool is no longer declared, and the Chat Completions request builder
 * (openclaw#174797, new in 2026.11.6) replays the call and its result as assistant
 * text: "[tool call id=… name=…]", "[tool result …]". Strict providers refuse that
 * trailing assistant message, and a model may call the tool again (openclaw#202415,
 * fixed upstream by #202436 after 2026.11.6). The next turn now keeps the hydrated
 * tools while the session's own tool list is unchanged, so the exchange stays a
 * native tool call and result; a tool list the policy changed drops them, and a later
 * call hydrates the tool again.
 */
export const runtimeBundlePatches = Object.freeze({
  "2026.11.6": Object.freeze([
    Object.freeze({
      id: "lease-release-retry",
      file: "dist/openclaw-state-lease-storage-BBSi-Imk.mjs",
      before:
        "const o = n + (a ? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS : LEASE_CONTENTION_RETRY_TIMEOUT_MS);",
      after: "const o = n + (a ? 3e4 : LEASE_CONTENTION_RETRY_TIMEOUT_MS);",
    }),
    // Carry both restart resume entries forward on every pin bump until upstream
    // offers a switch that turns automatic resumption off; the patch contract and
    // verify-assistant-installation.mjs fail otherwise
    // (tests/helpers/restart-resume-guard.js).
    Object.freeze({
      id: "no-restart-resume",
      file: "dist/session-restart-resume-BzRgzT_h.mjs",
      before:
        "const r = n.resumeAfterRestart ?? (n.mainRestartRecovery && " +
        'n.abortedLastRun === true && n.status === "interrupted" && ' +
        "n.updatedAt <= o && n.updatedAt >= o - LEGACY_RESTART_RESUME_WINDOW_MS ? " +
        "{ queuedInputIds: [] } : void 0);",
      after: "const r = void 0 /* AgentPier never resumes an interrupted turn */;",
    }),
    Object.freeze({
      id: "no-restart-resume-inputs",
      file: "dist/session-restart-resume-BzRgzT_h.mjs",
      before: "s.flatMap(({ entry: e }) => e.resumeAfterRestart?.queuedInputIds ?? [])",
      after: "[] /* AgentPier never replays a queued message after a restart */",
    }),
    // Drop both hydrated-tools entries once the pin carries openclaw#202436; the patch
    // contract and verify-assistant-installation.mjs fail while neither is in place
    // (tests/helpers/hydrated-tools-guard.js).
    Object.freeze({
      id: "hydrated-tools-kept",
      file: "dist/tool-send-receipts-oBTeJUW8.mjs",
      before: "const v = d || !sameTools(m, s);",
      after:
        "const keepHydrated = s.length === 0 || sameTools(m, s) /* AgentPier */; " +
        "const v = !sameTools(m, s) || d;",
    }),
    Object.freeze({
      id: "hydrated-tools-kept-list",
      file: "dist/tool-send-receipts-oBTeJUW8.mjs",
      before: "tools: v ? m.slice() : c.context.tools?.slice()",
      after:
        "tools: v ? [...m, ...(keepHydrated ? (c.context.tools ?? []).filter((e) => " +
        "!m.some((t) => t.name === e.name)) : [])] : c.context.tools?.slice()",
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
