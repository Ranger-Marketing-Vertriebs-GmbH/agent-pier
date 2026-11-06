import { writeChatImages } from "./chat-image-input.js";
import { nativeComposerImages, nativeImageDraft } from "./native-image-paste.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { assertManualInputSettled } from "./manual-input-guard.js";
import { requestPendingProblem } from "../../application/request-input-guard.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { assertInteractiveSession } from "../pipelines/native-session.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isNativeSlashCommand, sendSlashCommand } from "./session-slash-command.js";
import { problem } from "../../lib/storage.js";
import { SESSION_PREFIX } from "./tmux-naming.js";
import {
  claudeComposerImages,
  claudeImageDraft,
  claudeImageMessage,
} from "./claude-image-paste.js";
import { nativeFreshInput, nativePromptState } from "./native-prompt.js";
import { clearClaudeComposer } from "./claude-composer.js";
import { claudeFreshInput } from "./claude-prompt.js";
import { cliDefinition, isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import { clean, unknownComposer as unknown } from "../clis/tui-screen.js";

export function normalizeChatText(text) {
  if (typeof text !== "string" || !text || text.length > 32000)
    throw problem(serverMessages.sessionInput.invalid, 400);
  const normalized = text.replace(/\r\n?/g, "\n");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(normalized))
    throw problem(serverMessages.sessionInput.controlCharacters, 400);
  return normalized;
}

async function pasteText(manager, target, text) {
  const buffer = `${SESSION_PREFIX}${randomUUID()}`;
  try {
    await manager.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
    await manager.tmux(["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", target]);
  } catch (error) {
    await manager.tmux(["delete-buffer", "-b", buffer]).catch(() => {});
    throw error;
  }
}

/**
 * Caller holds the session lock and has verified the composer and generation.
 *
 * Claude image messages are pasted in two steps: the image paths first, then,
 * once every chip shows in the still short prompt, the text. Claude places
 * chips before the text either way, but a long text can no longer scroll
 * unconfirmed chips out of a short pane. Journal phases: paste-intent,
 * images-pasted, text-intent, pasted. `resume: "text"` continues after
 * images-pasted with the chips already in the prompt.
 */
export async function writeChatTuiInput(
  manager,
  session,
  value,
  {
    submitOnly = false,
    resume = null,
    initialImages = 0,
    message,
    onPhase = async () => {},
    onNotice = async () => {},
    onDialog = async () => {},
    confirmSubmit = async () => {},
    imageTimeoutMs,
    // Separates the message from a draft it is appended to.
    pastePrefix = () => "",
  } = {},
) {
  const text = normalizeChatText(value);
  const target = `${manager.target(session.id)}:0.0`;
  const slash = isNativeSlashCommand(session.tool, text);
  const images =
    message === undefined
      ? !slash && !submitOnly
        ? await claudeImageMessage(text)
        : null
      : message;
  if (resume === "text" && !images)
    throw problem(serverMessages.sessionInput.invalid, 400);
  if (!submitOnly && images) {
    await writeChatImages({
      manager,
      session,
      images,
      resume,
      initialImages,
      imageTimeoutMs,
      onPhase,
      onNotice,
      onDialog,
      pastePrefix,
      paste: (value) => pasteText(manager, target, value),
    });
  } else if (!submitOnly) {
    await onPhase("paste-intent");
    if (slash) await sendSlashCommand(manager, session, text, false);
    else await pasteText(manager, target, pastePrefix() + text);
    await onPhase("pasted");
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
  return isCodingCli(tool);
}

/** A visible substring never establishes the contents of a wrapped/collapsed draft. */
export function inspectChatComposer(tool, raw, pane = {}) {
  if (typeof raw !== "string" || !Number.isInteger(pane.cursorY)) return unknown();
  const lines = raw.split("\n");
  const row = pane.cursorY;
  const line = lines[row];
  if (line === undefined || !Number.isInteger(pane.cursorX)) return unknown();
  if (!isCodingCli(tool)) return unknown();
  return cliDriver(tool).tui.composer({
    raw,
    lines,
    row,
    line,
    plain: clean(line),
    pane,
  });
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
  if (session.purpose || !isCodingCli(session.tool))
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
    // When the pane's process started: a CLI may need a while to show its prompt.
    // A restarted CLI runs in a new process that can be much younger than its
    // tmux session, so the process start time wins; `ps` reports it in UTC.
    paneStartedAt: Date.parse(`${processStart} UTC`) || Number(started) * 1000,
    composer: inspectChatComposer(session.tool, raw, pane),
  };
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
    const check = async (matches, inspect = true) => {
      if (!active) throw problem(serverMessages.sessionInput.transactionEnded, 409);
      const current = await currentChatSession(manager, id);
      const fresh = await chatInputSnapshot(manager, current);
      assertManualInputSettled(manager, id, fresh);
      if (!active) throw problem(serverMessages.sessionInput.transactionEnded, 409);
      // A native blocking screen (hook review, startup dialog) waits as a request.
      if (
        cliDriver(current.tool).tui.blockingScreen?.(fresh.raw, {
          cwd: current.cwd,
          started: fresh.nativeStarted,
        })
      )
        throw requestPendingProblem();
      if (fresh.generation !== initial.generation)
        throw problem(serverMessages.sessionInput.generationChanged, 409);
      if (inspect && !matches(fresh.composer, fresh))
        throw problem(serverMessages.sessionInput.composerConflict, 409);
      return fresh;
    };
    try {
      return await operation({
        session,
        ...initial,
        /**
         * Empties the native prompt box when `owned(fresh)` accepts the current
         * screen; false when it does not or the box did not end up empty. Uses the
         * draft-clearing keys of a fresh delivery, never Escape or Ctrl-C.
         */
        clearPrompt: async (owned) => {
          if (attempted || checking)
            throw problem(serverMessages.sessionInput.alreadyAttempted, 409);
          attempted = true;
          const snapshot = () => check(null, false);
          const fresh = await snapshot();
          if (!owned(fresh)) return false;
          if (cliDefinition(session.tool).capabilities.imagePaste) {
            const timing = manager.chatInputTiming?.clear;
            await clearClaudeComposer(manager, session, fresh, snapshot, timing);
            return true;
          }
          const input = nativeFreshInput({
            tool: session.tool,
            manager,
            session,
            snapshot,
            notice: async () => {},
            text: "",
            timing: manager.chatInputTiming,
          });
          return (
            nativePromptState(session.tool, await input.prepare(fresh)).state === "empty"
          );
        },
        write: async (value, options = {}) => {
          const text = normalizeChatText(value);
          const submitOnly = options.submitOnly === true;
          const resume = !submitOnly && options.resume === "text" ? "text" : null;
          const freshInput =
            !submitOnly && !resume && options.allowComposerDraft === true;
          // Enter for text pasted before a hold is checked against the
          // prompt box seen after that paste instead of an exact one-line match.
          // A dialog keeps it waiting; without a proof the exact text must show.
          // Text after held image chips is checked the same way.
          const proven = submitOnly || Boolean(resume);
          const inspectComposer = submitOnly || resume ? !proven : !freshInput;
          // Claude dialogs swallow a paste and take Enter as their confirmation.
          // Each native adapter prepares drafts and guards dialogs.
          const chips = cliDefinition(session.tool).capabilities.imagePaste;
          const imageRules = cliDriver(session.tool).tui.images;
          const replace = !submitOnly && !resume;
          const snapshot = () => check(null, false);
          const notices = new Set();
          const notice = async (code) => {
            if (notices.has(code)) return;
            notices.add(code);
            await options.onNotice?.(code);
          };
          if (attempted || checking)
            throw problem(serverMessages.sessionInput.alreadyAttempted, 409);
          checking = true;
          let initialImages = 0;
          let message = null;
          let matches;
          let chipsOnly;
          let promptInput;
          try {
            if (!isNativeSlashCommand(session.tool, text))
              message = await claudeImageMessage(text);
            if (resume && !message)
              throw problem(serverMessages.sessionInput.invalid, 400);
            // Claude shows image paths as chips, so an image draft matches with
            // its chips in place of the paths.
            matches = submitOnly
              ? (composer) =>
                  message
                    ? claudeImageDraft(composer, message, { text: message.text })
                    : composer.state === "text" && composer.text === text
              : resume
                ? (composer) => claudeImageDraft(composer, message)
                : (composer) => composer.state === "empty";
            // Chips of a held message, also wrapped over several rows.
            chipsOnly = (fresh) =>
              chips
                ? imageRules.draft(fresh.composer, message) ||
                  imageRules.chipsOnly(fresh.raw, fresh.pane, message.images.length)
                : nativeImageDraft(session.tool, fresh, message);
            promptInput =
              (replace || proven) &&
              (chips ? claudeFreshInput : nativeFreshInput)({
                tool: session.tool,
                manager,
                session,
                snapshot,
                notice,
                escape: options.closeMenus !== false,
                onProof: (proof) => options.onProof?.(proof),
                // The text paste follows the chips: its last line must show.
                text: message ? message.text : text,
                timing: manager.chatInputTiming,
              });
            // Keystrokes typed in the terminal may not have rendered yet. Fresh
            // chat input takes over that draft instead of refusing the message.
            const typed = (freshInput || proven) && manager.pendingTerminalInput?.has(id);
            if (typed) {
              await sleep(150);
              manager.pendingTerminalInput.delete(id);
            }
            let current = await check(matches, inspectComposer && (!replace || !chips));
            if (message && !chips)
              matches = (_composer, fresh) =>
                nativeImageDraft(session.tool, fresh, message, {
                  text: submitOnly ? message.text : "",
                });
            if (submitOnly && !chips)
              await promptInput.beforeResubmit(options.promptProof, matches);
            // Replacing a draft already writes keys; never repeat it in this transaction.
            attempted = true;
            if (replace) current = await promptInput.prepare(current);
            else if (freshInput && (typed || current.composer.state === "text"))
              await notice("CHAT_APPENDED_TO_DRAFT");
            if (replace)
              initialImages = chips
                ? claudeComposerImages(current.raw, current.pane)
                : nativeComposerImages(session.tool, current.raw, current.pane);
          } finally {
            checking = false;
          }
          await writeChatTuiInput(manager, session, text, {
            ...options,
            resume,
            message,
            initialImages,
            imageTimeoutMs: manager.chatInputTiming?.imagesMs,
            pastePrefix: () => (replace ? promptInput.pastePrefix() : ""),
            onNotice: notice,
            onDialog: async () => {
              await options.beforeImage?.();
              await promptInput.dismissOpen();
            },
            // The intent is durable before its guard, so a change during the write
            // is still caught. A refused guard proves no bytes were written: the
            // caller restores its last proven phase instead of staying uncertain.
            onPhase: async (phase) => {
              await options.onPhase?.(phase);
              // Best effort: without a proof a held Enter falls back to uncertain.
              if (phase === "pasted" && (replace || resume))
                await promptInput.afterPaste().catch(() => {});
              if (!["paste-intent", "text-intent", "submit-intent"].includes(phase))
                return;
              try {
                if (phase === "paste-intent") {
                  const current = await check(matches, inspectComposer && !replace);
                  if (replace) await promptInput.beforePaste(current);
                } else if (phase === "text-intent") {
                  await check(matches, false);
                  // A question that opened after the chips holds the text.
                  if (resume)
                    await promptInput.beforeResume(options.promptProof, chipsOnly);
                  else await promptInput.beforeText();
                } else {
                  await check(matches, inspectComposer && submitOnly);
                  // Held image-only chips have no text step to prove them.
                  if (resume && !message.text)
                    await promptInput.beforeResume(options.promptProof, chipsOnly, {
                      text: false,
                    });
                  if (replace || resume) await promptInput.beforeSubmit();
                  else if (proven)
                    await promptInput.beforeResubmit(options.promptProof, matches);
                  // Enter must not submit a draft whose image paths went astray.
                  if (replace && message && !message.text)
                    await promptInput.assertImages(
                      Number.isInteger(initialImages) ? initialImages : 0,
                    );
                }
              } catch (error) {
                await options.onRefused?.(phase);
                throw error;
              }
            },
            confirmSubmit: promptInput.confirm,
          });
          return { notices: [...notices] };
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
