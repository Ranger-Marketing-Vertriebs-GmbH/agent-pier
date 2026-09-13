import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { hookLaunchIdentity } from "./codex-hook-trust.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { problem } from "../../lib/storage.js";

export function folderTrustScreen(raw, cwd) {
  if (typeof raw !== "string" || raw.length > 64000 || typeof cwd !== "string")
    return null;
  const text = stripVTControlCharacters(raw).replaceAll("\u00a0", " ").trim();
  const match = text.match(
    /^─{20,}\n Accessing workspace:\n\n([\s\S]+?)\n\n Quick safety check:/,
  );
  if (!match) return null;
  // Rejoin only native wrapping boundaries, preserving spaces within path segments.
  let offsets = new Set([0]);
  for (const line of match[1].split("\n").map((s) => s.trim())) {
    const next = new Set();
    for (const offset of offsets)
      for (const separator of offset ? ["", " "] : [""]) {
        const value = separator + line;
        if (cwd.startsWith(value, offset)) next.add(offset + value.length);
      }
    offsets = next;
  }
  if (!offsets.has(cwd.length)) return null;
  const compact = text.replace(/\s+/g, " ");
  if (!compact.includes("Claude Code'll be able to read, edit, and execute files here."))
    return null;
  const choices = compact.match(
    /Security guide ([❯ ]*)No, exit ([❯ ]*)Yes, I trust this folder Enter to confirm · Esc to cancel$/,
  );
  if (!choices || [choices[1], choices[2]].filter((s) => s.includes("❯")).length !== 1)
    return null;
  return { selected: choices[2].includes("❯") ? "trust" : "exit" };
}
async function json(file) {
  try {
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/** Launch/binding identity of a Claude session and whether its native receipt exists. */
export async function startupState(broker, session) {
  const launch = await json(broker.file(session.id));
  if (
    !launch ||
    launch.id !== session.id ||
    typeof launch.token !== "string" ||
    !launch.token ||
    launch.accountId !== session.accountId ||
    launch.tool !== "claude" ||
    launch.cwd !== session.cwd
  )
    return null;
  const base = path.join(broker.directory, "..", "native-sessions", session.id);
  const binding = await json(base + ".launch.json");
  if (
    !binding ||
    binding.id !== session.id ||
    typeof binding.token !== "string" ||
    !binding.token ||
    binding.accountId !== session.accountId ||
    binding.tool !== "claude" ||
    binding.cwd !== session.cwd
  )
    return null;
  const receipt = await json(base + ".receipt.json");
  return {
    launch,
    binding,
    started: receipt?.token === binding.token,
    identity: hookLaunchIdentity(launch),
  };
}
export const folderId = (current) =>
  createHash("sha256")
    .update(`claude-folder:${current.identity}:${current.binding.token}`)
    .digest("hex");
export async function answerFolderTrust(broker, entry, choice) {
  if (!["trust", "exit"].includes(choice)) throw problem(copy.invalid, 400);
  return broker.sessions.control(entry.sessionId, async (control) => {
    const current = await startupState(broker, control.session);
    if (
      !current ||
      current.started ||
      current.identity !== entry.launchIdentity ||
      folderId(current) !== entry.id ||
      broker.entries.get(entry.id) !== entry
    )
      throw problem(copy.stale, 409);
    // Claude ignores confirmations during its initial interactive-screen settling window.
    // Wait only for this explicit startup decision, then re-inspect before any keys.
    await delay(Math.max(0, 750 - (Date.now() - Date.parse(entry.createdAt))));
    let menu = folderTrustScreen(await control.screen(), control.session.cwd);
    if (!menu) throw problem(copy.stale, 409);
    if (menu.selected !== choice)
      await control.keys([choice === "trust" ? "Down" : "Up"]);
    const selectEnd = Date.now() + 1500;
    while (Date.now() < selectEnd) {
      menu = folderTrustScreen(await control.screen(), control.session.cwd);
      if (!menu) throw problem(copy.stale, 409);
      if (menu.selected === choice) break;
      await delay(25);
    }
    const verified = await startupState(broker, control.session);
    if (
      !verified ||
      folderId(verified) !== entry.id ||
      menu.selected !== choice ||
      (await broker.launchIdentity(entry.sessionId)) !== entry.launchIdentity
    )
      throw problem(copy.stale, 409);
    await control.keys(["Enter"]);
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await delay(25);
      if (choice === "exit") {
        if (!folderTrustScreen(await control.screen(), control.session.cwd)) return;
      } else {
        const next = await startupState(broker, control.session);
        if (next?.identity !== entry.launchIdentity) throw problem(copy.stale, 409);
        const config = current.launch.claudeTrustFile
          ? await json(current.launch.claudeTrustFile)
          : null;
        if (
          next.started ||
          config?.projects?.[control.session.cwd]?.hasTrustDialogAccepted === true
        )
          return;
      }
    }
    throw problem(copy.unknown, 409);
  });
}
