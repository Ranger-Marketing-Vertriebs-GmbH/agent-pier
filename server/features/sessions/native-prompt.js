import { setTimeout as sleep } from "node:timers/promises";
import { composerProblem } from "./claude-composer.js";

const plain = (value) => value.replace(/\x1b\[[0-9;:]*m/g, "");
const unknown = () => ({ state: "unknown" });

/** Native geometry, not transcript text, identifies the input we may edit. */
export function nativePromptState(tool, { raw, pane }) {
  if (!raw || !Number.isInteger(pane?.cursorY)) return unknown();
  const rows = raw.split("\n").slice(0, pane.height);
  const lines = rows.map(plain);
  const cursor = pane.cursorY;
  if (tool === "codex") {
    const start = rows.findLastIndex(
      (row, i) => i <= cursor && /^\x1b\[1m›\x1b\[0m /.test(row),
    );
    if (start >= 0) {
      const footer = lines.findLastIndex(
        (row, i) => i > start && /^  .+ · .+/.test(row) && !lines[i - 1]?.trim(),
      );
      const end = footer - 2;
      if (
        cursor >= start &&
        cursor <= end &&
        lines
          .slice(start + 1, end + 1)
          .every((row) => !row.trim() || row.startsWith("  ")) &&
        !lines[end + 1]?.trim() &&
        /^  .+ · .+/.test(lines[end + 2] || "")
      ) {
        const content = lines.slice(start, end + 1).map((row) => row.slice(2));
        const placeholder =
          start === end &&
          pane.cursorX === 2 &&
          /^\x1b\[1m›\x1b\[0m \x1b\[2m[^\x1b]+\x1b\[0m$/.test(rows[start]);
        return { state: placeholder ? "empty" : "draft", rows: content };
      }
    }
    // Native selectors end with this footer; a normal composer above wins.
    const bottom = lines
      .filter((row) => row.trim())
      .slice(-4)
      .join("\n");
    if (
      /\b(?:enter|esc)\b.*(?:select|confirm|continue|cancel|back|quit|deny|reject)/i.test(
        bottom,
      )
    )
      return { state: "dialog" };
  }
  if (tool === "opencode") {
    const footer = lines
      .filter((row) => row.trim())
      .slice(-5)
      .join(" ");
    const dialog =
      lines.slice(-14).some((row) => /^ *┃ +△ Permission required *$/.test(row)) ||
      (/┃/.test(footer) &&
        /enter\s+confirm/.test(footer) &&
        /Allow once|Reject|select/.test(footer)) ||
      rows.some((row) => /\x1b\[1m/.test(row) && /^ +\S.* +esc *$/.test(plain(row)));
    const unreadable = () => (dialog ? { state: "dialog" } : unknown());
    // Prefer the active prompt to old permission output in the transcript.
    const prefix = /^( *)┃  /.exec(lines[cursor] || "");
    if (!prefix) return unreadable();
    const indent = prefix[1];
    const border = `${indent}┃`;
    let top = cursor,
      bottom = cursor;
    while (
      top > 0 &&
      lines[top - 1].startsWith(border) &&
      lines[top - 1].trimEnd() !== border
    )
      top--;
    while (
      bottom + 1 < lines.length &&
      lines[bottom + 1].startsWith(border) &&
      lines[bottom + 1].trimEnd() !== border
    )
      bottom++;
    if (
      lines[top - 1]?.trimEnd() !== border ||
      lines[bottom + 1]?.trimEnd() !== border ||
      !lines[bottom + 2]?.startsWith(`${border}  `) ||
      !/ · \S/.test(lines[bottom + 2]) ||
      !lines[bottom + 3]?.startsWith(`${indent}╹▀▀▀`)
    )
      return unreadable();
    const content = lines
      .slice(top, bottom + 1)
      .map((row) => row.slice(indent.length + 3).trimEnd());
    const placeholder =
      top === bottom &&
      pane.cursorX === indent.length + 3 &&
      (!content[0] || rows[top].includes("\x1b[38;2;128;128;128mAsk anything… "));
    return { state: placeholder ? "empty" : "draft", rows: content };
  }
  return unknown();
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
  const stateOf = (fresh) => nativePromptState(tool, fresh);
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
          (state.rows.join("\n").endsWith(text) ||
            (tool === "codex" && state.rows.join("").endsWith(text.replaceAll("\n", ""))))
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
