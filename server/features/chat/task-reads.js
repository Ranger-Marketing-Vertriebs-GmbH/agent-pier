import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { cliDriver } from "../clis/drivers.js";
import { isCodingCli } from "../clis/catalog.js";
import { PAGE_MESSAGES } from "./history-page-split.js";
import { truncateToolRow } from "./tool-text.js";

export const OUTPUT_TAIL = 256 * 1024;
const subagentReader = (tool) =>
  isCodingCli(tool) ? cliDriver(tool).history.readSubagent : undefined;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const unknownTask = () => problem(serverMessages.chat.taskUnknown, 404);
const unavailable = () => problem(serverMessages.chat.taskTranscriptUnavailable, 409);

/**
 * The CLI's task file only where Claude Code keeps it for this very session:
 * <temp>/claude-<uid>/<project>/<provider session id>/tasks/<task id>.output, with
 * no link on the way. The session id is the server's own, not the record's.
 */
async function trustedOutputPath(file, roots, uid, sessionId, taskId) {
  if (
    typeof file !== "string" ||
    uid === undefined ||
    typeof sessionId !== "string" ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file
  )
    return null;
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const parts = relative.split(path.sep);
    if (
      parts.length !== 5 ||
      parts[0] !== `claude-${uid}` ||
      !parts[1] ||
      parts[2] !== sessionId ||
      parts[3] !== "tasks" ||
      parts[4] !== `${taskId}.output`
    )
      continue;
    try {
      const folder = await fs.realpath(path.dirname(file));
      if (folder === path.join(await fs.realpath(root), ...parts.slice(0, 4)))
        return file;
    } catch {
      /* A missing folder is as good as a missing file. */
    }
  }
  return null;
}

/** The last bytes of a file, from a character boundary; null when it cannot be read. */
async function readTail(file) {
  let handle;
  try {
    handle = await fs.open(file, READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const start = Math.max(0, info.size - OUTPUT_TAIL);
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let from = 0;
    while (start > 0 && from < bytesRead && (buffer[from] & 0xc0) === 0x80) from += 1;
    return {
      text: buffer.subarray(from, bytesRead).toString("utf8"),
      truncated: start > 0,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Reads of the tasks a session's current observability lists, and nothing else. */
export class TaskReads {
  constructor({
    sessions,
    chat,
    history,
    tempRoots = [os.tmpdir(), "/tmp"],
    uid = process.getuid?.(),
  }) {
    this.sessions = sessions;
    this.chat = chat;
    this.history = history;
    this.tempRoots = tempRoots;
    this.uid = uid;
  }
  async listed(sessionId, key, taskId) {
    const state = await this.chat.read(sessionId);
    const entry = state?.observability?.[key]?.find((item) => item.id === taskId);
    if (!entry) throw unknownTask();
    return { state, entry };
  }
  async transcript(sessionId, taskId) {
    const { state, entry } = await this.listed(sessionId, "subagents", taskId);
    const session = await this.sessions.get(sessionId);
    const parent = state.providerSessionId;
    const read = subagentReader(session.tool);
    if (!read || typeof parent !== "string") throw unavailable();
    const content = await read(this.history, session, parent, taskId);
    const all = content.messages || [];
    return {
      messages: all.slice(-PAGE_MESSAGES).map((message) => {
        const { toolImages: _images, toolImagePath: _path, ...rest } = message;
        return truncateToolRow(rest).row;
      }),
      partial: content.partialWhileRunning === true && entry.status === "running",
      truncated: all.length > PAGE_MESSAGES,
    };
  }
  async output(sessionId, taskId) {
    const { state } = await this.listed(sessionId, "shells", taskId);
    const gone = { text: "", truncated: false, gone: true };
    const file = this.chat.shellOutputFile(sessionId, taskId);
    const trusted = await trustedOutputPath(
      file,
      [this.tempRoots].flat(),
      this.uid,
      state.providerSessionId,
      taskId,
    );
    const tail = trusted && (await readTail(trusted));
    return tail ? { ...tail, gone: false } : gone;
  }
  /** What the browser may ask for per entry; no file is touched. */
  flags(session, kind, entry) {
    return kind === "shell"
      ? { hasOutput: Boolean(this.chat.shellOutputFile(session.id, entry.id)) }
      : { hasTranscript: Boolean(subagentReader(session.tool)) };
  }
}
