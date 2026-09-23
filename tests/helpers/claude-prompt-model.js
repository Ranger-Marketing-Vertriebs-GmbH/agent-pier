import { SessionOperations } from "../../server/features/sessions/session-operations.js";

const border = (width) => `\x1b[38;2;136;136;136m${"─".repeat(width)}`;

/**
 * In-process model of Claude Code 2.1.x prompt-box editing, matching the key
 * behavior validated against the real CLI: Ctrl-E, Ctrl-U, Backspace, Delete,
 * bracketed paste and Enter. A fixed `dialog` frame replaces the prompt box.
 */
export function claudePromptModel({
  draft = "",
  cursor,
  dialog,
  ignoreEnter,
  escapeCloses = true,
  width = 120,
  height = 35,
  status = "",
} = {}) {
  const lines = draft.split("\n");
  const model = {
    lines,
    line: cursor?.line ?? lines.length - 1,
    col: cursor?.col ?? lines.at(-1).length,
    dialog,
    ignoreEnter,
    escapeCloses,
    // Enter or text sent while a dialog is shown (it would confirm the dialog).
    dialogInput: [],
    submitted: [],
    keys: [],
    insert(text) {
      const [first, ...rest] = text.split("\n");
      const current = model.lines[model.line];
      const tail = current.slice(model.col);
      model.lines[model.line] = current.slice(0, model.col) + first;
      if (!rest.length) {
        model.col += first.length;
        model.lines[model.line] += tail;
        return;
      }
      model.lines.splice(model.line + 1, 0, ...rest);
      model.line += rest.length;
      model.col = model.lines[model.line].length;
      model.lines[model.line] += tail;
    },
    key(name) {
      model.keys.push(name);
      if (model.dialog) {
        // Escape closes Claude's modal (and declines a permission prompt).
        if (name === "Escape" && model.escapeCloses) model.dialog = null;
        else if (name !== "Escape") model.dialogInput.push(name);
        return;
      }
      const current = model.lines[model.line];
      if (name === "C-e") model.col = current.length;
      else if (name === "C-u") {
        model.lines[model.line] = current.slice(model.col);
        model.col = 0;
      } else if (name === "BSpace") {
        if (model.col > 0) {
          model.lines[model.line] =
            current.slice(0, model.col - 1) + current.slice(model.col);
          model.col--;
        } else if (model.line > 0) {
          const previous = model.lines[model.line - 1];
          model.lines.splice(model.line - 1, 2, previous + current);
          model.line--;
          model.col = previous.length;
        }
      } else if (name === "DC") {
        if (model.col < current.length)
          model.lines[model.line] =
            current.slice(0, model.col) + current.slice(model.col + 1);
        else if (model.line < model.lines.length - 1)
          model.lines.splice(model.line, 2, current + model.lines[model.line + 1]);
      } else if (name === "Enter") {
        if (model.ignoreEnter) return;
        model.submitted.push(model.lines.join("\n"));
        model.lines = [""];
        model.line = 0;
        model.col = 0;
      }
    },
    screen() {
      if (model.dialog) return model.dialog;
      const rows = Array.from({ length: height }, () => "");
      rows[0] = "Synthetic Claude transcript";
      const top = height - model.lines.length - 3;
      // A busy turn shows its spinner line above the prompt box.
      if (status) rows[top - 2] = status;
      rows[top] = border(width);
      model.lines.forEach((text, index) => {
        const prefix = index ? "  " : "\x1b[39m❯ ";
        const atCursor = index === model.line;
        rows[top + 1 + index] =
          atCursor && model.col === text.length
            ? `${prefix}${text}\x1b[7m \x1b[0m`
            : atCursor
              ? `${prefix}${text.slice(0, model.col)}\x1b[7m${text[model.col]}\x1b[0m${text.slice(model.col + 1)}`
              : prefix + text;
      });
      rows[top + 1 + model.lines.length] = border(width);
      rows[top + 2 + model.lines.length] = "\x1b[39m  ? for shortcuts";
      return {
        raw: rows.join("\n"),
        pane: { cursorX: 2 + model.col, cursorY: top + 1 + model.line, width, height },
      };
    },
  };
  return model;
}

/** A session manager whose tmux transport drives a claudePromptModel. */
export function claudeModelManager(model, session = {}) {
  const operations = new SessionOperations(() => Promise.resolve());
  const buffers = new Map();
  const manager = {
    replacing: new Set(),
    events: [],
    target: () => "=synthetic",
    current: async () => ({
      id: "one",
      tool: "claude",
      accountId: "fixture",
      status: "running",
      ...session,
    }),
    serial: (operation, id) => operations.run(operation, id),
    tmux: async (args, options) => {
      if (args[0] === "display-message") {
        const { raw, pane } = model.screen();
        return `%1|${process.pid}|1|${pane.cursorX}|${pane.cursorY}|${pane.width}|${pane.height}|0\n${raw}`;
      }
      manager.events.push({ args, input: options?.input });
      if (args[0] === "load-buffer") buffers.set(args[2], options.input);
      if (args[0] === "paste-buffer") {
        const pasted = buffers.get(args[args.indexOf("-b") + 1]);
        // A native dialog discards a bracketed paste.
        if (model.dialog) model.dialogInput.push(pasted);
        else model.insert(pasted);
      }
      if (args[0] === "send-keys") {
        const keys = args.slice(args.indexOf("-t") + 2);
        if (args.includes("-l")) model.insert(keys.at(-1));
        else for (const name of keys) model.key(name);
      }
      return "";
    },
  };
  return manager;
}
