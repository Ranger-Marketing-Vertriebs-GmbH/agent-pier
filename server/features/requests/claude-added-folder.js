// Claude Code asks at startup whether to trust each folder passed with --add-dir that
// it does not trust yet ("Adding a new directory:"). AgentPier passes only the chat
// attachment folder (clis/claude/session-config.js) and records its trust beforehand
// (clis/claude/attachment-trust.js); this recognizes the dialog for when it shows anyway.
import { realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { wrappedPath } from "./claude-folder-trust.js";

export const ADDED_FOLDER_OPTIONS = [
  { id: "exit", label: "No, exit" },
  { id: "add", label: "Yes, add it" },
];
const DESCRIPTION = "Claude Code'll be able to read, edit, and execute files here.";
// Claude holds a confirmation it takes for typed text and shows this hint instead of
// its footer; it then accepts Enter only right after ↓.
const FOOTER =
  /^(?:Enter to confirm · Esc to cancel|Esc to exit · To add it, press ↓ to Yes, then Enter(?: \(your text is kept\))?)$/;

/** The folders a Claude session may show in the dialog: its chat attachment folder. */
export function addedFolders(session) {
  const directory = session?.attachments?.directory;
  if (typeof directory !== "string" || !directory) return [];
  let real = directory;
  try {
    real = realpathSync(directory);
  } catch {
    // A missing folder is shown as passed.
  }
  return [...new Set([directory, real])];
}

/**
 * Recognizes the startup dialog for one of `folders`: anchored on its own rule and
 * heading, the path rejoined across wraps, and the exact choices and footer at the
 * end of the screen. Returns `{ path, selected: "exit" | "add" }` or null.
 */
export function addedFolderScreen(raw, folders) {
  if (typeof raw !== "string" || raw.length > 64000 || !Array.isArray(folders))
    return null;
  const screen = stripVTControlCharacters(raw).replaceAll(" ", " ").trim();
  const start = [
    ...screen.matchAll(/(?:^|\n)(?=─{20,}\n Adding a new directory:\n)/g),
  ].at(-1);
  if (!start) return null;
  const body = screen.slice(start.index).replace(/^\n/, "").split("\n").slice(2);
  // The path ends where the dialog's text starts; a short window drops the blank lines.
  const end = body.findIndex((line) =>
    /^ (?:This session hasn't|This directory is part of the repository at )/.test(line),
  );
  if (end < 1) return null;
  const lines = body.slice(0, end).filter((line) => line.trim());
  const path = folders.find(
    (folder) => typeof folder === "string" && folder && wrappedPath(lines, folder),
  );
  if (!path) return null;
  const text = body.slice(end).join(" ").replace(/\s+/g, " ").trim();
  const choices = text.match(/ Security guide ([❯ ]*)No, exit ([❯ ]*)Yes, add it (.*)$/);
  if (
    !choices ||
    !FOOTER.test(choices[3]) ||
    choices[3].length > 120 ||
    !text.startsWith("This ") ||
    !text.slice(0, choices.index).includes(DESCRIPTION) ||
    /[❯─]/.test(text.slice(0, choices.index)) ||
    [choices[1], choices[2]].filter((s) => s.includes("❯")).length !== 1
  )
    return null;
  return { path, selected: choices[2].includes("❯") ? "add" : "exit" };
}
