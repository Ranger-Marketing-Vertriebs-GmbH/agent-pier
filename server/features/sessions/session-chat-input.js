import { serverMessages } from "../../lib/i18n/de.js";
import { assertManualInputSettled } from "./manual-input-guard.js";
import { startupScreen } from "../requests/claude-startup-prompts.js";
import { requestCopy } from "../../lib/i18n/de/requests.js";
import { hookTrustScreen } from "../requests/codex-hook-trust.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { assertInteractiveSession } from "../pipelines/native-session.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isNativeSlashCommand, sendSlashCommand } from "./session-slash-command.js";
import { problem } from "../../lib/storage.js";
import { claudeComposerImages, waitForClaudeImagePaste } from "./claude-image-paste.js";
import {
  assertClaudeComposer,
  claudeComposerState,
  clearClaudeComposer,
  confirmClaudeSubmit,
  composerProblem,
  claudePlaceholder,
} from "./claude-composer.js";

export function normalizeChatText(text) {
  if (typeof text !== "string" || !text || text.length > 32000)
    throw problem(serverMessages.sessionInput.invalid, 400);
  const normalized = text.replace(/\r\n?/g, "\n");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(normalized))
    throw problem(serverMessages.sessionInput.controlCharacters, 400);
  return normalized;
}

/** Caller holds the session lock and has verified the composer and generation. */
export async function writeChatTuiInput(
  manager,
  session,
  value,
  {
    submitOnly = false,
    initialImages = 0,
    onPhase = async () => {},
    confirmSubmit = async () => {},
  } = {},
) {
  const text = normalizeChatText(value);
  const target = `${manager.target(session.id)}:0.0`;
  const slash = isNativeSlashCommand(session.tool, text);
  if (!submitOnly) {
    await onPhase("paste-intent");
    if (slash) await sendSlashCommand(manager, session, text, false);
    else {
      const buffer = `tuiui-${randomUUID()}`;
      try {
        await manager.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
        await manager.tmux([
          "paste-buffer",
          "-d",
          "-p",
          "-r",
          "-b",
          buffer,
          "-t",
          target,
        ]);
      } catch (error) {
        await manager.tmux(["delete-buffer", "-b", buffer]).catch(() => {});
        throw error;
      }
    }
    await onPhase("pasted");
    if (!slash) await waitForClaudeImagePaste(manager, session, text, { initialImages });
  }
  // Preserve the native Codex literal-input paste-burst separation.
  if (slash && session.tool === "codex") await sleep(250);
  await onPhase("submit-intent");
  await manager.tmux(["send-keys", "-t", target, "Enter"]);
  await onPhase("submitted");
  await confirmSubmit({ slash });
}

// Native release validation is separate from transport and screen characterization.
// Enable a tool only after docs/direct-chat-tui-validation.md records its busy matrix.
export function supportsDirectChat(tool) {
  return ["codex", "claude", "opencode"].includes(tool);
}

const unknown = () => ({ state: "unknown", text: null });
const clean = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");

/** A visible substring never establishes the contents of a wrapped/collapsed draft. */
export function inspectChatComposer(tool, raw, pane = {}) {
  if (typeof raw !== "string" || !Number.isInteger(pane.cursorY)) return unknown();
  const lines = raw.split("\n");
  const row = pane.cursorY;
  const line = lines[row];
  if (line === undefined || !Number.isInteger(pane.cursorX)) return unknown();
  const plain = clean(line);
  if (tool === "codex") {
    if (
      !line.startsWith("\x1b[1m›\x1b[0m ") ||
      clean(lines[row + 1] || "").trim() ||
      !/^  .+ · .+/.test(clean(lines[row + 2] || ""))
    )
      return unknown();
    if (/^\x1b\[1m›\x1b\[0m \x1b\[2m[^\x1b]+\x1b\[0m$/.test(line))
      return pane.cursorX === 2 ? { state: "empty", text: "" } : unknown();
    const text = plain.slice(2);
    if (
      !text ||
      /\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(text) ||
      plain.length >= pane.width - 1 ||
      pane.cursorX !== plain.length
    )
      return unknown();
    return { state: "text", text };
  }
  if (tool === "claude") {
    const border = "─".repeat(pane.width || 0);
    if (
      !border ||
      clean(lines[row - 1] || "") !== border ||
      clean(lines[row + 1] || "") !== border ||
      !plain.startsWith("❯ ")
    )
      return unknown();
    if (
      pane.cursorX === 2 &&
      (plain === "❯ " ||
        (plain === "❯  " && /\x1b\[7m(?:\x1b\[39m)? /.test(line)) ||
        claudePlaceholder(line, pane))
    )
      return { state: "empty", text: "" };
    // Claude's own cursor cell, or the native terminal cursor after plain text.
    const draft =
      /^\x1b\[39m❯ ([^\x1b]+)\x1b\[7m \x1b\[0m$/.exec(line)?.[1] ??
      /^\x1b\[39m❯[ \u00a0]([^\x1b]+)$/.exec(line)?.[1];
    if (
      draft &&
      !/\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(draft) &&
      pane.cursorX === 2 + draft.length &&
      pane.cursorX < pane.width - 1
    )
      return { state: "text", text: draft };
    return unknown();
  }
  if (tool === "opencode") {
    const prefix = /^( *)┃  /.exec(plain);
    if (!prefix) return unknown();
    const indent = prefix[1];
    const blank = (value) => clean(value || "").trimEnd() === `${indent}┃`;
    if (
      !blank(lines[row - 1]) ||
      !blank(lines[row + 1]) ||
      !clean(lines[row + 2] || "").startsWith(`${indent}┃  `) ||
      !/^[^·\x00-\x1f\x7f-\x9f]+ · \S/.test(
        clean(lines[row + 2] || "").slice(indent.length + 3),
      ) ||
      !clean(lines[row + 3] || "").startsWith(`${indent}╹▀▀▀`)
    )
      return unknown();
    const start = indent.length + 3;
    const draft = /\x1b\[38;2;238;238;238m([^\x1b]+)\x1b\[38;2;255;255;255m/.exec(
      line,
    )?.[1];
    if (
      draft &&
      !/\[Pasted|[\x00-\x1f\x7f-\x9f]/.test(draft) &&
      pane.cursorX === start + draft.length &&
      plain.slice(start, start + draft.length) === draft &&
      /^ *$/.test(plain.slice(start + draft.length)) &&
      pane.cursorX < pane.width - 1
    )
      return { state: "text", text: draft };
    if (pane.cursorX !== start) return unknown();
    const content = plain.slice(start).trimEnd();
    if (
      !content ||
      (content.startsWith("Ask anything… ") &&
        line.includes("\x1b[38;2;128;128;128mAsk anything… "))
    )
      return { state: "empty", text: "" };
  }
  return unknown();
}

export function assertChatComposerReady(tool, raw, pane) {
  const composer = inspectChatComposer(tool, raw, pane);
  if (composer.state !== "empty")
    throw problem(
      composer.state === "text"
        ? serverMessages.sessionInput.composerDraft
        : serverMessages.sessionInput.composerUninspectable,
      409,
    );
}

async function currentChatSession(manager, id) {
  if (manager.replacing.has(id)) throw problem(serverMessages.sessions.reloading, 409);
  const session = await manager.current(id);
  if (session.reload?.state === "reloading")
    throw problem(serverMessages.sessions.reloading, 409);
  if (session.status !== "running") throw problem(serverMessages.sessions.stopped, 409);
  assertInteractiveSession(session);
  if (session.purpose || !["codex", "claude", "opencode"].includes(session.tool))
    throw problem(serverMessages.sessionInput.unsupported, 409);
  return session;
}

async function nativeGeneration(manager, session) {
  if (!session.nativeBinding?.enabled) return { identity: null, recoverable: true };
  const directory = path.join(manager.directory, "..", "native-sessions");
  let launch;
  try {
    launch = JSON.parse(
      await readFile(path.join(directory, `${session.id}.launch.json`), "utf8"),
    );
  } catch {
    throw problem(serverMessages.sessionInput.launchIdentityInvalid, 409);
  }
  if (
    !launch ||
    launch.id !== session.id ||
    launch.accountId !== session.accountId ||
    launch.tool !== session.tool ||
    typeof launch.token !== "string" ||
    !launch.token ||
    launch.cwd !==
      (typeof session.cwd === "string" ? await realpath(session.cwd) : session.cwd)
  )
    throw problem(serverMessages.sessionInput.launchIdentityChanged, 409);
  let receipt;
  try {
    receipt = JSON.parse(
      await readFile(path.join(directory, `${session.id}.receipt.json`), "utf8"),
    );
  } catch (error) {
    // Codex registers its native conversation on the first UserPromptSubmit.
    // The live pane and launch authorize initial input, never later recovery.
    if (error.code === "ENOENT")
      return {
        identity: [launch.token, "awaiting-native-receipt"],
        launchToken: launch.token,
        recoverable: false,
      };
    throw problem(serverMessages.sessionInput.receiptInvalid, 409);
  }
  if (
    !receipt ||
    launch.token !== receipt.token ||
    receipt.id !== session.id ||
    receipt.accountId !== session.accountId ||
    receipt.tool !== session.tool ||
    receipt.cwd !== launch.cwd
  )
    throw problem(serverMessages.sessionInput.identityChanged, 409);
  if (
    !Number.isInteger(receipt.pid) ||
    receipt.pid <= 0 ||
    !receipt.pidStart ||
    pidStart(receipt.pid) !== receipt.pidStart
  )
    throw problem(serverMessages.sessionInput.processChanged, 409);
  return {
    identity: [receipt.providerSessionId, receipt.pid, receipt.pidStart, launch.token],
    launchToken: launch.token,
    providerSessionId: receipt.providerSessionId,
    recoverable: true,
  };
}

export async function chatInputSnapshot(manager, session) {
  const captured = await manager.tmux([
    "display-message",
    "-p",
    "-t",
    `${manager.target(session.id)}:0.0`,
    "#{pane_id}|#{pane_pid}|#{session_created}|#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{pane_dead}",
    ";",
    "capture-pane",
    "-e",
    "-p",
    "-t",
    `${manager.target(session.id)}:0.0`,
  ]);
  const newline = captured.indexOf("\n");
  const [paneId, pid, started, x, y, width, height, dead] = captured
    .slice(0, newline)
    .split("|");
  if (
    newline < 0 ||
    !/^%\d+$/.test(paneId) ||
    !/^\d+$/.test(pid) ||
    dead !== "0" ||
    ![x, y, width, height].every((value) => /^\d+$/.test(value || ""))
  )
    throw problem(serverMessages.sessionInput.terminalIdentityUninspectable, 409);
  const processStart = pidStart(Number(pid));
  if (!processStart) throw problem(serverMessages.sessions.stopped, 409);
  const native = await nativeGeneration(manager, session);
  const generation = createHash("sha256")
    .update(
      JSON.stringify([
        session.id,
        session.accountId,
        session.tool,
        session.restartGeneration || 0,
        paneId,
        pid,
        started,
        processStart,
        native.identity,
      ]),
    )
    .digest("hex");
  const raw = captured.slice(newline + 1);
  const pane = {
    cursorX: Number(x),
    cursorY: Number(y),
    width: Number(width),
    height: Number(height),
  };
  return {
    raw,
    pane,
    providerSessionId: native.providerSessionId || null,
    generation,
    observationGeneration: createHash("sha256")
      .update(
        JSON.stringify([
          session.id,
          session.accountId,
          session.tool,
          session.restartGeneration || 0,
          paneId,
          pid,
          started,
          processStart,
          native.launchToken || null,
        ]),
      )
      .digest("hex"),
    recoveryGeneration: native.recoverable ? generation : null,
    // A bound Claude session without its native receipt is still starting up.
    nativeStarted: native.recoverable,
    composer: inspectChatComposer(session.tool, raw, pane),
  };
}

/** Enter must only follow a paste Claude actually shows in its prompt box. */
async function awaitClaudePaste(snapshot, state, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const current = state(await snapshot());
    if (["text", "draft"].includes(current.state)) return;
    if (current.state !== "empty") assertClaudeComposer(current, ["text", "draft"]);
    if (performance.now() >= deadline) throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
    await sleep(25);
  }
}

/** Inspection and optional writing share the exact lock used by terminal input. */
export function withChatInput(manager, id, operation) {
  if (manager.replacing.has(id))
    return Promise.reject(problem(serverMessages.sessions.reloading, 409));
  return manager.serial(async () => {
    const session = await currentChatSession(manager, id);
    const initial = await chatInputSnapshot(manager, session);
    let active = true;
    let attempted = false;
    let checking = false;
    const check = async (text, submitOnly, inspect = true) => {
      if (!active) throw problem(serverMessages.sessionInput.transactionEnded, 409);
      const current = await currentChatSession(manager, id);
      const fresh = await chatInputSnapshot(manager, current);
      assertManualInputSettled(manager, id, fresh);
      if (!active) throw problem(serverMessages.sessionInput.transactionEnded, 409);
      if (
        (current.tool === "codex" && hookTrustScreen(fresh.raw)) ||
        (current.tool === "claude" &&
          startupScreen(fresh.raw, current.cwd, { started: fresh.nativeStarted }))
      )
        throw problem(requestCopy.pendingInput, 409);
      if (fresh.generation !== initial.generation)
        throw problem(serverMessages.sessionInput.generationChanged, 409);
      if (
        inspect &&
        (submitOnly
          ? fresh.composer.state !== "text" || fresh.composer.text !== text
          : fresh.composer.state !== "empty")
      )
        throw problem(serverMessages.sessionInput.composerConflict, 409);
      return fresh;
    };
    try {
      return await operation({
        session,
        ...initial,
        write: async (value, options = {}) => {
          const text = normalizeChatText(value);
          const submitOnly = options.submitOnly === true;
          const inspectComposer = submitOnly || options.allowComposerDraft !== true;
          // Claude dialogs swallow a paste and take Enter as their confirmation.
          // Fresh Claude input therefore requires its prompt box and replaces a draft.
          const claude = session.tool === "claude";
          const replace = claude && !submitOnly;
          const claudeState = (fresh) =>
            claudeComposerState(fresh.raw, fresh.pane, fresh.composer);
          const snapshot = () => check(text, false, false);
          if (attempted || checking)
            throw problem(serverMessages.sessionInput.alreadyAttempted, 409);
          checking = true;
          let initialImages = 0;
          try {
            let fresh = await check(text, submitOnly, inspectComposer && !replace);
            // Replacing a draft already writes keys; never repeat it in this transaction.
            attempted = true;
            if (replace)
              fresh = await clearClaudeComposer(manager, session, fresh, snapshot);
            if (claude) initialImages = claudeComposerImages(fresh.raw, fresh.pane);
          } finally {
            checking = false;
          }
          return writeChatTuiInput(manager, session, text, {
            ...options,
            initialImages,
            // The intent is durable before its guard, so a change during the write
            // is still caught. A refused guard proves no bytes were written: the
            // caller restores its last proven phase instead of staying uncertain.
            onPhase: async (phase) => {
              await options.onPhase?.(phase);
              if (!["paste-intent", "submit-intent"].includes(phase)) return;
              try {
                if (phase === "paste-intent") {
                  const fresh = await check(
                    text,
                    submitOnly,
                    inspectComposer && !replace,
                  );
                  if (replace) assertClaudeComposer(claudeState(fresh), ["empty"]);
                } else {
                  await check(text, submitOnly, inspectComposer && submitOnly);
                  if (replace) await awaitClaudePaste(snapshot, claudeState);
                }
              } catch (error) {
                await options.onRefused?.(phase);
                throw error;
              }
            },
            confirmSubmit: claude
              ? ({ slash }) => confirmClaudeSubmit(snapshot, { slash })
              : undefined,
          });
        },
      });
    } finally {
      active = false;
    }
  }, id);
}

export function inputChat(manager, id, value, beforeInput, options = {}) {
  const text = normalizeChatText(value);
  return withChatInput(manager, id, async (tx) => {
    assertChatComposerReady(tx.session.tool, tx.raw, tx.pane);
    if (beforeInput) await beforeInput(tx.session, tx.raw, tx);
    return tx.write(text, options);
  });
}
