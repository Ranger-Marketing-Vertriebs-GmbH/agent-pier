import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { craftStacks, defaultCraftStack } from "./craft-stacks.js";

const messages = serverMessages.craft;
const REQUEST_LIMIT = 8000;
const modes = ["clean-room", "deep"];

/** A rebuild's request (also a follow-up's): trimmed, not empty, at most 8000 chars. */
export function cleanRequest(value) {
  const request = typeof value === "string" ? value.trim() : "";
  if (!request) throw problem(messages.rebuildRequestRequired, 400);
  if (request.length > REQUEST_LIMIT) throw problem(messages.rebuildRequestTooLong, 400);
  return request;
}

/** `-` (none), an http(s) address or an absolute path. */
function cleanTarget(value) {
  if (value === undefined || value === null) return "-";
  const target = typeof value === "string" ? value.trim() : null;
  if (target === "" || target === "-") return "-";
  if (target && !/[\x00-\x1f\x7f]/.test(target) && target.length <= 2048) {
    if (path.isAbsolute(target)) return target;
    try {
      const url = new URL(target);
      if (["http:", "https:"].includes(url.protocol)) return target;
    } catch {
      // Not an address either.
    }
  }
  throw problem(messages.rebuildTargetInvalid, 400);
}

function cleanStack(value) {
  if (value === undefined || value === null || value === "") return defaultCraftStack;
  if (!craftStacks.includes(value)) throw problem(messages.rebuildStackInvalid, 400);
  return value;
}

function cleanRounds(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 10)
    throw problem(messages.rebuildRoundsInvalid, 400);
  return value;
}

function cleanMode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!modes.includes(value)) throw problem(messages.invalidMode, 400);
  return value;
}

function cleanAutoMode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw problem(messages.rebuildAutoModeInvalid, 400);
  return value;
}

/**
 * A start's options. Only the owner chooses account, mode, auto mode and rounds; any
 * other source gets the owner's defaults (`settings`) and Craft Anything's rounds.
 */
export function cleanStart(input, source, settings) {
  const body = record(input) ? input : {};
  const owner = source === "owner";
  return {
    request: cleanRequest(body.request),
    target: cleanTarget(body.target),
    stack: cleanStack(body.stack),
    accountId:
      owner && typeof body.accountId === "string" && body.accountId
        ? body.accountId
        : settings.accountId,
    mode: owner ? cleanMode(body.mode, settings.mode) : settings.mode,
    autoMode: owner ? cleanAutoMode(body.autoMode, settings.autoMode) : settings.autoMode,
    rounds: owner ? cleanRounds(body.rounds) : null,
  };
}

/** A retry key of a session or agent start: a short string, else null. */
export const cleanRequestId = (value) =>
  typeof value === "string" && value && value.length <= 200 ? value : null;

/** The arguments of project_inbox_answer besides project and id. */
export function cleanAnswer(questionId, input) {
  const body = record(input) ? input : {};
  const answer = {};
  if (typeof body.choice === "string" && body.choice) answer.choice = body.choice;
  if (typeof body.text === "string" && body.text.trim()) answer.text = body.text;
  if (typeof body.allow === "boolean") answer.allow = body.allow;
  if (body.always === true) answer.always = true;
  const answered = "choice" in answer || "text" in answer || "allow" in answer;
  if (typeof questionId !== "string" || !questionId || !answered)
    throw problem(messages.rebuildAnswerInvalid, 400);
  return answer;
}

/** The owner's defaults from a settings body: `{ accountId, mode, autoMode }`. */
export function cleanSettings(input) {
  const body = record(input) ? input : {};
  const { accountId = null, mode = "clean-room", autoMode = false } = body;
  if (
    !(accountId === null || (typeof accountId === "string" && accountId)) ||
    !modes.includes(mode) ||
    typeof autoMode !== "boolean"
  )
    throw problem(messages.rebuildSettingsInvalid, 400);
  return { accountId, mode, autoMode };
}
