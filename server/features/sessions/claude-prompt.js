import { setTimeout as sleep } from "node:timers/promises";
import {
  claudeComposerState,
  clearClaudeComposer,
  composerProblem,
  confirmClaudeSubmit,
} from "./claude-composer.js";

const plain = (line) => (line || "").replace(/\x1b\[[0-9;:]*m/g, "");
// Escape needs positive evidence of a menu without a question: the rewind
// selector or model picker title right below its ▔ panel border. A footer alone
// never counts: a short pane scrolls a permission prompt's question away and
// leaves only its options and "Esc to cancel". In Claude's prompt, Escape would
// interrupt a running turn and Esc Esc opens the rewind selector.
const menuTitle = /^ *(?:Rewind|Select model) *$/;
// Permission prompts, plan approval and AskUserQuestion ask the user something;
// their options and footer identify them even when the question scrolled away.
const questionMarker =
  /Do you want to [^\n]*\?|Would you like to [^\n]*\?|Enter to select · [^\n]*to navigate|Tab to amend|ctrl\+e to explain|^ *\d+\. (?:Type something|Chat about this)\.?|^\s*[❯↓↑]?\s*\d+\.\s+(?:Yes|No)\b|^\s*[↓↑] \d+\. /im;

const stateOf = (fresh) =>
  claudeComposerState(fresh.raw, fresh.pane, fresh.composer).state;
const kind = (fresh) => (stateOf(fresh) === "unknown" ? "unreadable" : "draft");
const visibleRows = (fresh) => {
  const rows = fresh.raw.split("\n");
  return (
    Number.isInteger(fresh.pane?.height) ? rows.slice(0, fresh.pane.height) : rows
  ).map(plain);
};
const menuPanel = (rows) =>
  rows.some(
    (row, index) =>
      /^▔{8}/.test(row) &&
      rows.slice(index + 1, index + 3).some((next) => menuTitle.test(next)),
  );

/**
 * A native dialog that asks the user something (permission prompt, plan
 * approval, AskUserQuestion). It is answered by the user, never closed by
 * AgentPier: Escape would deny or cancel it. Any other question-shaped row near
 * the dialog also counts, so an unknown dialog errs toward waiting.
 */
export function claudeQuestion(fresh) {
  if (stateOf(fresh) !== "dialog") return false;
  const bottom = visibleRows(fresh).slice(-24);
  return (
    questionMarker.test(bottom.join("\n")) ||
    bottom.some((row) => /^ +[^❯⏺⎿ ][^\n]*\?\s*$/.test(row))
  );
}

/**
 * A Claude menu without a question that Escape closes: only the rewind selector
 * or model picker, recognized by the title inside its panel. Unknown menus wait.
 */
export function closableClaudeDialog(fresh) {
  if (stateOf(fresh) !== "dialog" || claudeQuestion(fresh)) return false;
  return menuPanel(visibleRows(fresh));
}

async function waitUntil(snapshot, fresh, done, timeoutMs, stepMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (!done(fresh) && performance.now() < deadline) {
    await sleep(stepMs);
    fresh = await snapshot();
  }
  return fresh;
}

/**
 * Close a Claude menu with single Escape presses until its prompt box returns.
 * Escape is only sent while a closable menu footer is visible and at least
 * `settleMs` after the previous press, so it can neither interrupt a turn nor
 * form Esc Esc. A question is never touched (`CHAT_QUESTION_OPEN`); a menu that
 * stays open ends with `CHAT_DIALOG_NOT_CLOSED`. Both release the session lock
 * quickly: the caller keeps the message pending and retries later.
 */
export async function dismissClaudeDialog(
  manager,
  session,
  initial,
  snapshot,
  {
    attempts = 3,
    settleMs = 1200,
    waitMs = 500,
    escape = true,
    onEscape = async () => {},
  } = {},
) {
  const target = `${manager.target(session.id)}:0.0`;
  const open = (fresh) => stateOf(fresh) === "dialog";
  let fresh = initial;
  if (claudeQuestion(fresh)) throw composerProblem("CHAT_QUESTION_OPEN");
  for (
    let attempt = 0;
    escape && attempt < attempts && closableClaudeDialog(fresh);
    attempt++
  ) {
    await onEscape();
    await manager.tmux(["send-keys", "-t", target, "Escape"]);
    fresh = await waitUntil(
      snapshot,
      await snapshot(),
      (value) => !open(value),
      settleMs,
    );
  }
  fresh = await waitUntil(snapshot, fresh, (value) => !open(value), waitMs);
  if (open(fresh))
    throw composerProblem(
      claudeQuestion(fresh) ? "CHAT_QUESTION_OPEN" : "CHAT_DIALOG_NOT_CLOSED",
    );
  // Let Ink finish redrawing the prompt box before it is judged.
  return waitUntil(snapshot, fresh, (value) => stateOf(value) !== "unknown", 500, 25);
}

/**
 * Make Claude's prompt ready for a fresh chat message. A dialog is closed, a
 * draft is replaced; when an empty prompt cannot be proven (no progress, key or
 * time budget, unreadable layout) the message is appended to whatever the prompt
 * holds instead of being refused. Returns the fresh snapshot and `appended`:
 * false, "draft" (text stays in front of the message) or "unreadable". Only a
 * dialog that stays open refuses.
 */
export async function prepareClaudePrompt(manager, session, initial, snapshot, options) {
  let fresh = initial;
  for (let round = 0; round < 3; round++) {
    // An unreadable frame may be Ink mid-redraw; give it a moment.
    fresh = await waitUntil(
      snapshot,
      fresh,
      (value) => stateOf(value) !== "unknown",
      round ? 0 : 500,
      25,
    );
    const state = stateOf(fresh);
    if (state === "empty") return { fresh, appended: false };
    if (state === "unknown") return { fresh, appended: "unreadable" };
    if (state === "dialog") {
      fresh = await dismissClaudeDialog(
        manager,
        session,
        fresh,
        snapshot,
        options?.dialog,
      );
      continue;
    }
    try {
      return {
        fresh: await clearClaudeComposer(
          manager,
          session,
          fresh,
          snapshot,
          options?.clear,
        ),
        appended: false,
      };
    } catch (error) {
      if (
        ![
          "CHAT_COMPOSER_DIALOG",
          "CHAT_COMPOSER_NOT_CLEARED",
          "CHAT_COMPOSER_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      fresh = await snapshot();
      // Clearing stalled: whatever remains in the prompt is sent along.
      if (stateOf(fresh) !== "dialog") return { fresh, appended: kind(fresh) };
    }
  }
  if (stateOf(fresh) === "dialog")
    throw composerProblem(
      claudeQuestion(fresh) ? "CHAT_QUESTION_OPEN" : "CHAT_DIALOG_NOT_CLOSED",
    );
  return { fresh, appended: stateOf(fresh) !== "empty" && kind(fresh) };
}

/**
 * Before Enter: the paste must show in the prompt box. A menu that opened
 * meanwhile is closed first; a question is left alone and Enter is never sent
 * while any dialog is visible (`CHAT_QUESTION_OPEN` or `CHAT_DIALOG_NOT_CLOSED`
 * with the text pasted). An
 * unreadable layout does not stop the submit (`lenient` after a short wait); an
 * emptied prompt means the paste was lost and stays unconfirmed.
 */
export async function awaitClaudePaste(
  snapshot,
  dismiss,
  { timeoutMs = 2000, unknownMs = 300, dismissals = 2 } = {},
) {
  const started = performance.now();
  for (;;) {
    const fresh = await snapshot();
    const state = stateOf(fresh);
    if (["text", "draft"].includes(state)) return { unreadable: false };
    if (state === "dialog") {
      if (dismissals-- <= 0)
        throw composerProblem(
          claudeQuestion(fresh) ? "CHAT_QUESTION_OPEN" : "CHAT_DIALOG_NOT_CLOSED",
        );
      await dismiss(fresh);
      continue;
    }
    const elapsed = performance.now() - started;
    if (state === "unknown" && elapsed >= unknownMs) return { unreadable: true };
    if (elapsed >= timeoutMs) throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
    await sleep(25);
  }
}

/**
 * Fresh Claude chat input within one transaction: prepare the prompt, check the
 * paste before Enter and confirm the submit. `notice` records informational
 * codes; `timing` (tests only) shortens the native waits.
 */
export function claudeFreshInput({
  manager,
  session,
  snapshot,
  notice,
  escape = true,
  timing = {},
}) {
  // Escape only closes menus without a question; still tell the user.
  const dialog = {
    ...timing.dialog,
    escape,
    onEscape: () => notice("CHAT_DIALOG_CLOSED"),
  };
  let appended = false;
  const append = async (kind) => {
    if (!kind || appended) return;
    appended = kind;
    await notice(
      kind === "unreadable" ? "CHAT_PROMPT_UNREADABLE" : "CHAT_APPENDED_TO_DRAFT",
    );
  };
  return {
    async prepare(current) {
      const result = await prepareClaudePrompt(manager, session, current, snapshot, {
        dialog,
        clear: timing.clear,
      });
      await append(result.appended);
      return result.fresh;
    },
    /** Right before the paste: a dialog or draft may have appeared meanwhile. */
    async beforePaste(current) {
      const { state } = claudeComposerState(current.raw, current.pane, current.composer);
      if (state === "dialog" || (!appended && state !== "empty"))
        await this.prepare(current);
    },
    async beforeSubmit() {
      const result = await awaitClaudePaste(
        snapshot,
        (current) => dismissClaudeDialog(manager, session, current, snapshot, dialog),
        timing.paste,
      );
      if (result.unreadable) await append("unreadable");
    },
    /** A message appended to a visible draft starts on its own line. */
    pastePrefix: () => (appended === "draft" ? "\n" : ""),
    confirm: ({ slash }) =>
      confirmClaudeSubmit(snapshot, {
        slash,
        // An unreadable prompt cannot show that it emptied.
        unreadable: appended === "unreadable",
        ...timing.confirm,
      }),
  };
}
