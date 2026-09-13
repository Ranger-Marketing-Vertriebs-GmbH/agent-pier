import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { folderId, folderTrustScreen, startupState } from "./claude-folder-trust.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { problem } from "../../lib/storage.js";

const TRUST_OPTIONS = [
  { id: "trust", label: "Yes, I trust this folder", scope: "persistent" },
  { id: "exit", label: "No, exit" },
];
const clean = (raw) =>
  stripVTControlCharacters(raw)
    .replaceAll("\u00a0", " ")
    .split("\n")
    .map((line) => line.trimEnd());
const compact = (lines) => lines.join(" ").replace(/\s+/g, " ").trim();
const lastLine = (lines) => (lines.filter((line) => line.trim()).at(-1) || "").trim();
const hasLine = (lines, text) => lines.some((line) => line.trim() === text);
const marked = (lines, pattern) =>
  lines.map((line) => line.match(pattern)).filter(Boolean);
const selection = (matches, key) => {
  const chosen = matches.filter((m) => m[1] === "❯");
  return chosen.length === 1 ? key(chosen[0]) : undefined;
};
// Every dialog needs whole-line structure, never just quoted phrases in a transcript.
function themeDialog(lines, text) {
  if (
    !text.includes(
      "Choose the text style that looks best with your terminal To change this later, run /theme",
    )
  )
    return null;
  const rows = marked(lines, /^\s*(❯| )?\s*([1-9])\. (.+?)(?: ✔)?$/);
  if (rows.length < 2) return null;
  const selected = selection(rows, (m) => m[2]);
  if (!selected) return null;
  return {
    dialog: "theme",
    selected,
    options: rows.map((m) => ({ id: m[2], label: m[3] })),
  };
}
function apiKeyDialog(lines) {
  const heading = lines.findIndex(
    (line, index) =>
      /^─{20,}$/.test(line.trim()) &&
      lines[index + 1]?.trim() === "Detected a custom API key in your environment",
  );
  if (heading < 0 || lastLine(lines) !== "Enter to confirm · Esc to cancel") return null;
  if (!hasLine(lines, "Do you want to use this API key?")) return null;
  const rows = marked(lines, /^\s*(❯| )\s*(Yes|No \(recommended\))$/);
  if (rows.length !== 2) return null;
  const selected = selection(rows, (m) => (m[2] === "Yes" ? "yes" : "no"));
  if (!selected) return null;
  return {
    dialog: "apiKey",
    selected,
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No (recommended)" },
    ],
  };
}
function securityNotesDialog(lines) {
  if (
    !hasLine(lines, "Security notes:") ||
    !/^Press Enter to continue(…|\.{3})?$/.test(lastLine(lines))
  )
    return null;
  return {
    dialog: "securityNotes",
    selected: "continue",
    options: [{ id: "continue", label: "Continue" }],
  };
}
function loginDialog(lines) {
  const method =
    hasLine(lines, "Select login method:") && marked(lines, /^\s*(❯) 1\. /).length === 1;
  if (!method && lastLine(lines) !== "Paste code here if prompted >") return null;
  return { dialog: "login", selected: null, options: [] };
}
function unknownDialog(lines, text) {
  const footer = /(Enter to confirm|Press Enter to continue)/.test(lastLine(lines));
  if (!footer || !text.includes("❯")) return null;
  const rows = marked(lines, /^\s*(❯| )\s*(?:\d+\. )?(\S.*)$/);
  if (rows.filter((m) => m[1] === "❯").length !== 1) return null;
  return { dialog: "unknown", selected: null, options: [] };
}
/**
 * Recognizes Claude's interactive startup dialogs on the current screen.
 * `started` marks a native receipt; unknown menus are reported only before it.
 */
export function startupScreen(raw, cwd, { started = true } = {}) {
  if (typeof raw !== "string" || raw.length > 64000 || typeof cwd !== "string")
    return null;
  const trust = folderTrustScreen(raw, cwd);
  if (trust) return { dialog: "trust", selected: trust.selected, options: TRUST_OPTIONS };
  const lines = clean(raw);
  const text = compact(lines);
  if (!text) return null;
  return (
    themeDialog(lines, text) ||
    apiKeyDialog(lines) ||
    securityNotesDialog(lines) ||
    loginDialog(lines) ||
    (started ? null : unknownDialog(lines, text))
  );
}

const PRESENTATIONS = ["claudeFolderTrust", "claudeStartupPrompt"];
// Unknown menus share one id per launch: their card is identical, so a second
// unrecognized menu in the same launch keeps the existing request instead.
const promptId = (current, dialog) =>
  dialog === "trust"
    ? folderId(current)
    : createHash("sha256")
        .update(`claude-startup:${dialog}:${current.identity}:${current.binding.token}`)
        .digest("hex");
const expire = (broker, entry) => {
  // A poll queued behind an answer must not expire the request that answer removed.
  if (!entry || broker.entries.get(entry.id) !== entry) return;
  broker.entries.delete(entry.id);
  broker.emit(entry, "request.expired");
};
const localEntry = (broker, id) =>
  [...broker.entries.values()].find(
    (e) => e.sessionId === id && PRESENTATIONS.includes(e.presentation),
  );
/** Publishes the current Claude startup dialog as a local request, or expires it. */
export async function refreshStartupPrompts(broker, session) {
  if (
    session.tool !== "claude" ||
    !session.nativeRequests?.enabled ||
    !session.nativeBinding?.enabled ||
    session.status !== "running" ||
    !broker.sessions.control
  )
    return;
  const current = await startupState(broker, session);
  const previous = localEntry(broker, session.id);
  if (current?.started || !current) return expire(broker, previous);
  return broker.sessions.control(session.id, async (control) => {
    const fresh = await startupState(broker, control.session);
    const menu =
      fresh &&
      !fresh.started &&
      startupScreen(await control.screen(), control.session.cwd, { started: false });
    if (!menu) return expire(broker, previous);
    const id = promptId(fresh, menu.dialog);
    if (broker.entries.has(id)) return;
    expire(broker, previous);
    const trust = menu.dialog === "trust";
    const entry = {
      id,
      sessionId: session.id,
      accountId: session.accountId,
      launchIdentity: fresh.identity,
      local: true,
      presentation: trust ? "claudeFolderTrust" : "claudeStartupPrompt",
      kind: "permission",
      revision: 1,
      status: "pending",
      source: "claude",
      createdAt: new Date().toISOString(),
      subject: trust ? { path: control.session.cwd } : { dialog: menu.dialog },
      options: menu.options.map((option) => ({ ...option })),
    };
    broker.entries.set(id, entry);
    broker.emit(entry, "request.created");
  });
}
/** Moves the native selection to `choice`, confirms it and waits for the dialog to leave. */
export async function answerStartupPrompt(broker, entry, choice) {
  const dialog = entry.subject?.dialog;
  if (!entry.options.some((o) => o.id === choice)) throw problem(copy.invalid, 400);
  return broker.sessions.control(entry.sessionId, async (control) => {
    const stale = () => problem(copy.stale, 409);
    const verify = async () => {
      const current = await startupState(broker, control.session);
      if (
        !current ||
        current.started ||
        current.identity !== entry.launchIdentity ||
        promptId(current, dialog) !== entry.id ||
        broker.entries.get(entry.id) !== entry
      )
        throw stale();
    };
    const screen = async () =>
      startupScreen(await control.screen(), control.session.cwd, { started: false });
    const read = async () => {
      const menu = await screen();
      if (menu?.dialog !== dialog) throw stale();
      return menu;
    };
    await verify();
    // Claude ignores confirmations during its initial interactive-screen settling window.
    await delay(Math.max(0, 750 - (Date.now() - Date.parse(entry.createdAt))));
    let menu = await read();
    const index = (id) => menu.options.findIndex((o) => o.id === id);
    const selectEnd = Date.now() + 3000;
    while (menu.selected !== choice) {
      if (Date.now() > selectEnd) throw stale();
      const from = index(menu.selected),
        to = index(choice);
      if (from < 0 || to < 0) throw stale();
      await control.keys([to > from ? "Down" : "Up"]);
      const stepEnd = Date.now() + 1500;
      let next = await read();
      while (next.selected === menu.selected && Date.now() < stepEnd) {
        await delay(25);
        next = await read();
      }
      if (next.selected === menu.selected) throw stale();
      menu = next;
    }
    await verify();
    if ((await broker.launchIdentity(entry.sessionId)) !== entry.launchIdentity)
      throw stale();
    await control.keys(["Enter"]);
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await delay(25);
      const current = await startupState(broker, control.session);
      if (current?.identity !== entry.launchIdentity) throw stale();
      if (current.started) return;
      if ((await screen())?.dialog === dialog) continue;
      // A partial redraw may briefly hide the dialog; require it to stay gone.
      await delay(50);
      if ((await screen())?.dialog !== dialog) return;
    }
    throw problem(copy.unknown, 409);
  });
}
