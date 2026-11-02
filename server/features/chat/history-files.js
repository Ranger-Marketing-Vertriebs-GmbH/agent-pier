import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// File helpers shared by the facade in provider-history.js and each CLI's history.
export const MAX_HISTORY = 64 * 1024 * 1024;
export function providerId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value))
    throw problem(serverMessages.chat.invalidHistoryId);
  return value;
}
export async function readJsonLines(file, limit = MAX_HISTORY) {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > limit)
      throw problem(serverMessages.chat.historyTooLarge, 413);
    const text = await handle.readFile("utf8");
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop(); // The CLI may be in the middle of appending a record.
    return lines.filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    await handle.close();
  }
}
export async function inside(file, root) {
  const [realFile, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  if (!realFile.startsWith(realRoot + path.sep))
    throw problem(serverMessages.chat.historyOutsideProfile);
  return realFile;
}
