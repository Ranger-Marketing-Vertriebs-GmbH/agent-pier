import { setTimeout as sleep } from "node:timers/promises";

/** Slash commands belong to the native TUI, not the provider's message queue. */
export async function sendSlashCommand(manager, session, text, submit) {
  if (
    !["codex", "claude", "opencode"].includes(session.tool) ||
    !/^\/[a-z][a-z0-9_:-]*(?: +[^\r\n]*)?$/i.test(text) ||
    [...text].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return false;
  const target = `${manager.target(session.id)}:0.0`;
  await manager.tmux(["send-keys", "-l", "-t", target, "--", text]);
  if (submit) {
    // As with the native model picker, let Codex's paste-burst window close
    // before Enter so it submits the command instead of inserting a newline.
    if (session.tool === "codex") await sleep(250);
    await manager.tmux(["send-keys", "-t", target, "Enter"]);
  }
  return true;
}
