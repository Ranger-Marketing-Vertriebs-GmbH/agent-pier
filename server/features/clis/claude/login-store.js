/*
 * Where a managed Claude Code account keeps its login on macOS (docs/sandbox.md).
 *
 * Claude Code stores a login in the keychain by running `security`, and falls back to
 * `.credentials.json` in its config folder when the keychain has no item and cannot
 * take one. A sandboxed session cannot reach the keychain, so it only ever sees the
 * file. To give every session of an account the same store, AgentPier puts a
 * `security` stand-in first on PATH (keychain-shim.sh) that answers "not found" for
 * Claude Code's credential items, and moves an existing keychain item into the file
 * once. A marker file beside the config folder records that an account is on the
 * file store; only marked accounts get the stand-in.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const MARKER = "claude-login-store.json";
const NOT_FOUND = 44;

export const supported = (platform = process.platform) => platform === "darwin";
/** The stand-in AgentPier installs as `security`; its `real=` line names the real tool. */
export const shim = {
  name: "security",
  source: fileURLToPath(new URL("./keychain-shim.sh", import.meta.url)),
};

const configDirectory = (root) => path.join(root, "claude");
const loginFile = (root) => path.join(configDirectory(root), ".credentials.json");
const markerFile = (root) => path.join(root, MARKER);
export const marked = (root) => fs.existsSync(markerFile(root));

/** The keychain service Claude Code derives from CLAUDE_SECURESTORAGE_CONFIG_DIR. */
export function serviceName(configDir) {
  const hash = createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `Claude Code-credentials-${hash.slice(0, 8)}`;
}

/** `env` with the stand-in's folder first on PATH. */
export function environment(env, shimDirectory) {
  return {
    ...env,
    PATH: [shimDirectory, env.PATH].filter(Boolean).join(path.delimiter),
  };
}

// A stored login is a JSON object with at least one entry. `security -w` prints a
// value that is not plain text as hex, so that form is read too.
function parseLogin(text) {
  const trimmed = String(text ?? "").trim();
  const candidates = [trimmed];
  if (/^(?:[0-9a-f]{2})+$/i.test(trimmed))
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length
      )
        return { value, text: candidate };
    } catch {}
  }
  return null;
}
function readLoginFile(file) {
  try {
    return parseLogin(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
// A refreshed login expires later than the copy it replaced.
const expiry = (login) => Number(login?.value?.claudeAiOauth?.expiresAt) || 0;

function writeLoginFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, text);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return readLoginFile(file)?.text === text;
}

const service = (root) => serviceName(configDirectory(root));
async function readItem(root, { run, user }) {
  let result;
  try {
    result = await run(["find-generic-password", "-a", user, "-w", "-s", service(root)]);
  } catch {
    return { state: "unavailable" };
  }
  if (result?.code === NOT_FOUND) return { state: "absent" };
  if (result?.code !== 0) return { state: "unavailable" };
  const login = parseLogin(result.stdout);
  // An item AgentPier cannot read as a login is left where it is.
  return login ? { state: "found", login } : { state: "unavailable" };
}
async function deleteItem(root, { run, user }) {
  try {
    const result = await run([
      "delete-generic-password",
      "-a",
      user,
      "-s",
      service(root),
    ]);
    return result?.code === 0 || result?.code === NOT_FOUND;
  } catch {
    return false;
  }
}
const mark = (root) =>
  fs.writeFileSync(markerFile(root), `${JSON.stringify({ store: "file" })}\n`, {
    mode: 0o600,
  });
const unmark = (root) => fs.rmSync(markerFile(root), { force: true });

/**
 * Decides which store the account's next processes use and returns it: "file" (the
 * stand-in applies) or "keychain" (nothing changes).
 *
 * The move waits until no session of the account runs (`busy`). A session started
 * without the stand-in reads the keychain first, and when it refreshes its token it
 * writes the keychain and deletes the file, which would sign out every session
 * started with the stand-in. So an account changes store only while nothing of it
 * runs, and every process of it then uses the same one.
 *
 * Order: the file is written and read back before the keychain item is deleted, and
 * the account is marked last. A stop at any point leaves a login in at least one
 * store and the next call finishes the move. A keychain that cannot be read (locked,
 * no keychain in a service context) changes nothing.
 */
async function decide(root, { busy, run, user }) {
  const file = readLoginFile(loginFile(root));
  const wasMarked = marked(root);
  if (wasMarked && file) return "file";
  if (!wasMarked && (await busy())) return "keychain";
  const item = await readItem(root, { run, user });
  if (item.state === "unavailable") return wasMarked ? "file" : "keychain";
  if (item.state === "found") {
    // A marked account whose login is back in the keychain was used without the
    // stand-in (an older AgentPier after a downgrade). While its sessions run, it
    // stays on the keychain like them.
    if (wasMarked && (await busy())) {
      unmark(root);
      return "keychain";
    }
    if (!file || expiry(item.login) > expiry(file)) {
      if (!writeLoginFile(loginFile(root), item.login.text))
        return wasMarked ? "file" : "keychain";
    }
    // A leftover item would come back as the login after a later sign-out.
    if (!(await deleteItem(root, { run, user }))) return wasMarked ? "file" : "keychain";
  }
  mark(root);
  return "file";
}

const settling = new Map();
/** One decision at a time per account folder; see `decide`. */
export function settle(root, options) {
  const previous = settling.get(root) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => decide(root, options))
    .catch(() => (marked(root) ? "file" : "keychain"));
  settling.set(root, next);
  const done = () => {
    if (settling.get(root) === next) settling.delete(root);
  };
  next.then(done, done);
  return next;
}

/** Deletes what a removed account may have left in the keychain. */
export const forget = (root, options) => deleteItem(root, options);

// Whether a config folder holds a login file. Only its size is looked at ("{}" is
// what a signed-out profile may leave behind): nothing here reads a login to decide.
function holdsLoginFile(directory) {
  try {
    return fs.statSync(path.join(directory, ".credentials.json")).size > 2;
  } catch {
    return false;
  }
}
// Variables that sign Claude Code in without a stored login: a key or token, or a
// cloud provider's own credentials. They count in the environment a session gets
// (an account's API key in AgentPier, a provider connection) and under `env` in the
// profile's settings.json, where a key helper counts as well.
const LOGIN_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];
function signsInThroughSettings(directory) {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(directory, "settings.json"), "utf8"),
    );
    return (
      !!settings?.apiKeyHelper || LOGIN_VARIABLES.some((name) => settings?.env?.[name])
    );
  } catch {
    return false;
  }
}
const signsInElsewhere = (directory, env) =>
  LOGIN_VARIABLES.some((name) => env?.[name]) || signsInThroughSettings(directory);
/**
 * Whether the CLI's own profile (a local account) keeps its login where a sandboxed
 * session cannot read it: in the keychain rather than in `~/.claude/.credentials.json`
 * or in its settings, with nothing in `env` (the session's environment) signing in
 * either. The launch dialog says so; the launch is not refused, because such a profile
 * can sign in in ways the server does not see (an operator's sandbox profile, the
 * CLI's own configuration).
 */
export function localHidden(home, env = {}) {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return !holdsLoginFile(directory) && !signsInElsewhere(directory, env);
}
/**
 * Whether a managed account's login is still out of a sandboxed session's reach: the
 * account is not on the file store and has no login file either (a host whose
 * keychain cannot be used keeps the login in the file without AgentPier's doing),
 * and neither `env` (the session's environment) nor its settings sign it in. The
 * launch dialog says so and a sandboxed launch is refused, both from this answer.
 */
export const managedHidden = (root, env = {}) =>
  !marked(root) &&
  !holdsLoginFile(configDirectory(root)) &&
  !signsInElsewhere(configDirectory(root), env);
