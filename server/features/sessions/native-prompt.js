import { setTimeout as sleep } from "node:timers/promises";
import { composerProblem } from "./claude-composer.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

const unknown = () => ({ state: "unknown" });

/** Native geometry, not transcript text, identifies the input we may edit. */
export function nativePromptState(tool, { raw, pane }) {
  if (!raw || !Number.isInteger(pane?.cursorY) || !isCodingCli(tool)) return unknown();
  return cliDriver(tool).tui.promptState?.({ raw, pane }) ?? unknown();
}

const proofOf = (state) => (state.state === "draft" ? JSON.stringify(state.rows) : null);

/** Codex/OpenCode handoff policy; shared delivery owns waiting and journaling. */
export function nativeFreshInput({
  tool,
  manager,
  session,
  snapshot,
  notice,
  text,
  onProof = () => {},
  timing = {},
}) {
  const timeoutMs = timing.timeoutMs ?? 2000;
  const settleMs = timing.settleMs ?? 100;
  // A fresh TUI drops input until it draws its prompt; OpenCode can take tens of
  // seconds on first start. Until then an unreadable screen means "starting".
  const startupMs = timing.startupMs ?? 120_000;
  const stateOf = (fresh) => nativePromptState(tool, fresh);
  const promptProof = isCodingCli(tool) ? cliDriver(tool).tui.promptProof : undefined;
  const assertOpen = (fresh) => {
    const state = stateOf(fresh);
    if (state.state === "dialog") throw composerProblem("CHAT_DIALOG_NOT_CLOSED");
    return state;
  };
  let appended = false,
    unreadable = false,
    chipsProof = null;
  const fallback = async (state) => {
    if (state.state === "unknown") {
      unreadable = true;
      await notice("CHAT_PROMPT_UNREADABLE");
    } else if (state.state !== "empty") {
      appended = true;
      await notice("CHAT_APPENDED_TO_DRAFT");
    }
  };
  const guard = {
    async prepare(fresh) {
      const deadline = performance.now() + timeoutMs;
      let state = assertOpen(fresh);
      // Nothing was written yet: the delivery holds the message and retries.
      if (
        state.state === "unknown" &&
        Number.isFinite(fresh.paneStartedAt) &&
        Date.now() - fresh.paneStartedAt < startupMs
      )
        throw composerProblem("CHAT_CLI_STARTING");
      for (
        let round = 0;
        state.state === "draft" && round < 40 && performance.now() < deadline;
        round++
      ) {
        let changed = false;
        for (const keys of [["C-e", "C-u"], ["BSpace"], ["DC"]]) {
          const before = JSON.stringify([
            state.rows,
            fresh.pane.cursorX,
            fresh.pane.cursorY,
          ]);
          await manager.tmux([
            "send-keys",
            "-t",
            `${manager.target(session.id)}:0.0`,
            ...keys,
          ]);
          await sleep(settleMs);
          fresh = await snapshot();
          state = assertOpen(fresh);
          const moved =
            JSON.stringify([state.rows, fresh.pane.cursorX, fresh.pane.cursorY]) !==
            before;
          changed ||= moved;
          if (state.state !== "draft") break;
          if (moved && keys[0] === "BSpace") break;
        }
        if (!changed) break;
      }
      await fallback(state);
      return fresh;
    },
    async beforePaste(fresh) {
      const state = assertOpen(fresh);
      if (state.state === "draft" && !appended) await guard.prepare(fresh);
    },
    async afterPaste() {
      onProof(null);
      const deadline = performance.now() + 500;
      do {
        const state = stateOf(await snapshot());
        // Collapsed paste labels cannot prove the bytes behind them. Keep the
        // conservative exact-text recovery when the full prompt is unavailable.
        if (
          state.state === "draft" &&
          !state.rows.some((row) => /\[Pasted/.test(row)) &&
          (state.rows.join("\n").endsWith(text) || promptProof?.(state.rows, text))
        ) {
          onProof(proofOf(state));
          return;
        }
        if (state.state === "dialog") return;
        await sleep(25);
      } while (performance.now() < deadline);
    },
    async beforeSubmit() {
      const deadline = performance.now() + timeoutMs;
      do {
        const state = assertOpen(await snapshot());
        if (
          state.state === "draft" &&
          (chipsProof === null || proofOf(state) !== chipsProof)
        )
          return;
        if (state.state === "unknown") {
          await fallback(state);
          return;
        }
        await sleep(25);
      } while (performance.now() < deadline);
      throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
    },
    async dismissOpen() {
      assertOpen(await snapshot());
    },
    async beforeText() {
      const fresh = await snapshot();
      const state = assertOpen(fresh);
      chipsProof = proofOf(state);
      onProof(chipsProof);
    },
    async beforeResume(proof, matches, { text = true } = {}) {
      const fresh = await snapshot();
      const state = assertOpen(fresh);
      if (proof ? proof !== proofOf(state) : !matches(fresh))
        throw composerProblem("CHAT_PROMPT_CHANGED");
      if (text) chipsProof = proofOf(state);
    },
    async assertImages(before) {
      const state = assertOpen(await snapshot());
      if (
        state.rows &&
        [...state.rows.join("\n").matchAll(/\[Image\s+#?\s*\d+\]/g)].length <= before
      )
        throw composerProblem("CHAT_IMAGES_UNCONFIRMED");
    },
    async beforeResubmit(proof, matches) {
      const fresh = await snapshot();
      const state = assertOpen(fresh);
      if (proof ? proof !== proofOf(state) : !matches(fresh.composer, fresh))
        throw composerProblem("CHAT_PROMPT_CHANGED");
    },
    async confirm({ slash = false } = {}) {
      const deadline = performance.now() + timeoutMs;
      do {
        const state = stateOf(await snapshot());
        if (
          state.state === "empty" ||
          (slash && state.state === "dialog") ||
          (unreadable && state.state === "unknown")
        )
          return;
        await sleep(25);
      } while (performance.now() < deadline);
      throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
    },
    pastePrefix: () => (appended ? "\n" : ""),
  };
  return guard;
}
