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
  // Rows follow the /theme hint as one contiguous block. Claude 2.1.270 numbered
  // them ("❯ 2. Dark mode ✔"); 2.1.296 drops numbers and leads with the check mark.
  const start = lines.findIndex(
    (line) => line.trim() === "To change this later, run /theme",
  );
  // The phrase alone (quoted or wrapped differently) never anchors the rows.
  if (start < 0) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*╌/.test(line)) {
      if (block.length) break;
      continue;
    }
    block.push(line);
  }
  const rows = block.map((line) =>
    line.match(/^\s*(❯)?\s*(?:([1-9])\.\s+)?(?:✔\s+)?(\S.*?)(?:\s+✔)?$/),
  );
  if (rows.length < 2 || rows.length > 9 || rows.some((m) => !m || m[3].includes("❯")))
    return null;
  const numbered = rows.every((m, index) => m[2] === String(index + 1));
  if (!numbered && rows.some((m) => m[2])) return null;
  const options = rows.map((m, index) => ({ id: String(index + 1), label: m[3] }));
  const cursor = rows.flatMap((m, index) => (m[1] === "❯" ? [index] : []));
  if (cursor.length !== 1) return null;
  return { dialog: "theme", selected: options[cursor[0]].id, options };
}
function keyConfirmationDialog(lines) {
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
// Claude Code 2.1.304 asks these during a session too, after its native receipt:
// the auto mode default nudge at startup, the billing notice at a classifier check.
const SESSION_DIALOGS = new Set(["autoModeDefault", "autoModeBilling"]);
const AUTO_DEFAULT_TITLE = "Make auto mode your default permission mode?";
const AUTO_DEFAULT_ACCEPT = "Yes, set auto mode as my default permission mode";
const BILLING_TITLE =
  "We're changing auto mode to no longer charge for classifier requests in Claude Code.";
const BILLING_BODY =
  "Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.";
const rule = (line) => /^\s*[─━]{8,}\s*$/.test(line);
// Dialog frames may draw side borders; box-only rows carry no text.
const unboxed = (lines) =>
  lines
    .map((line) => line.replace(/^\s*[│┃]/, " ").replace(/[│┃]\s*$/, ""))
    .filter((line) => line.trim() && !/^\s*[╭╮╰╯─━│┃]+\s*$/.test(line));
/**
 * "Make auto mode your default permission mode?": two unnumbered rows end the
 * screen right below the title and its description; no footer, no composer.
 */
function autoModeDefaultDialog(lines) {
  const title = lines.findLastIndex((line) => line.trim() === AUTO_DEFAULT_TITLE);
  if (title < 0) return null;
  const rest = unboxed(lines.slice(title + 1));
  const rows = rest
    .slice(-2)
    .map((line) =>
      line.match(
        /^\s*(❯)?\s*(Yes, set auto mode as my default permission mode|No, keep [^❯]{1,40})$/,
      ),
    );
  if (
    rows.length !== 2 ||
    rows.some((m) => !m) ||
    rows[0][2] !== AUTO_DEFAULT_ACCEPT ||
    !rows[1][2].startsWith("No, keep ") ||
    rest.slice(0, -2).some((line) => rule(line) || /^\s*[❯›]/.test(line))
  )
    return null;
  const cursor = rows.flatMap((m, index) => (m[1] ? [index] : []));
  if (cursor.length !== 1) return null;
  const options = [
    { id: "accept", label: rows[0][2] },
    { id: "decline", label: rows[1][2].trim() },
  ];
  return { dialog: "autoModeDefault", selected: options[cursor[0]].id, options };
}
/**
 * The auto mode classifier billing notice: title, paragraphs and a key footer.
 * Enter continues in auto mode, Esc cancels (interrupts) the pending action.
 */
function autoModeBillingDialog(lines) {
  const start = lines.findLastIndex((line) =>
    line.includes("We're changing auto mode to no longer charge"),
  );
  if (start < 0) return null;
  const rows = unboxed(lines.slice(start));
  const footer = rows.at(-1)?.trim() || "";
  if (
    footer.length > 80 ||
    footer.includes("❯") ||
    !/(?:^|·\s*)(?:Enter to continue|Esc to cancel)(?:\s*·|$)/.test(footer) ||
    rows.slice(0, -1).some((line) => rule(line) || /^\s*[❯›]/.test(line))
  )
    return null;
  const text = compact(rows.slice(0, -1));
  if (!text.startsWith(BILLING_TITLE) || !text.includes(BILLING_BODY)) return null;
  return {
    dialog: "autoModeBilling",
    selected: null,
    keys: { continue: "Enter", cancel: "Escape" },
    options: [
      { id: "continue", label: "Continue" },
      { id: "cancel", label: "Cancel" },
    ],
  };
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
 * `sessionOnly` limits it to the dialogs Claude also shows after its receipt.
 */
export function startupScreen(raw, cwd, { started = true, sessionOnly = false } = {}) {
  if (typeof raw !== "string" || raw.length > 64000 || typeof cwd !== "string")
    return null;
  const lines = clean(raw);
  const session = autoModeDefaultDialog(lines) || autoModeBillingDialog(lines);
  if (session || sessionOnly) return session;
  const trust = folderTrustScreen(raw, cwd);
  if (trust) return { dialog: "trust", selected: trust.selected, options: TRUST_OPTIONS };
  const text = compact(lines);
  if (!text) return null;
  return (
    themeDialog(lines, text) ||
    keyConfirmationDialog(lines) ||
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
  if (!current) return expire(broker, previous);
  const scan = broker.sessions.control(session.id, async (control) => {
    const fresh = await startupState(broker, control.session);
    const menu =
      fresh &&
      startupScreen(await control.screen(), control.session.cwd, {
        started: fresh.started,
        sessionOnly: fresh.started,
      });
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
  // A running session's poll must not fail when the terminal is briefly unavailable
  // (reload, stop); the next poll looks again.
  return current.started ? scan.catch(() => {}) : scan;
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
        (current.started && !SESSION_DIALOGS.has(dialog)) ||
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
    // A notice without a selection answers with its own key (Enter or Esc).
    const key = menu.keys?.[choice];
    const selectEnd = Date.now() + 3000;
    while (!key && menu.selected !== choice) {
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
    await control.keys([key || "Enter"]);
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await delay(25);
      const current = await startupState(broker, control.session);
      if (current?.identity !== entry.launchIdentity) throw stale();
      if (current.started && !SESSION_DIALOGS.has(dialog)) return;
      if ((await screen())?.dialog === dialog) continue;
      // A partial redraw may briefly hide the dialog; require it to stay gone.
      await delay(50);
      if ((await screen())?.dialog !== dialog) return;
    }
    throw problem(copy.unknown, 409);
  });
}
