import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { TICKET_SOURCE_IDS } from "./ticket.js";
import { cliDefinition, isCodingCli } from "../clis/catalog.js";

const copy = serverMessages.tickets;
export const GITHUB_KEY =
  /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,8})$/;
export const PLANE_KEY = /^[A-Z0-9]{1,12}-[1-9]\d{0,8}$/;

const MAX_TICKETS = 50;
const MAX_TOKEN_BUDGET = 1e12;
const REPAIR_KEYS = [
  "tool",
  "accountId",
  "providerConnectionId",
  "providerModelId",
  "nativeModelId",
  "launchMode",
];

/** One spelling per GitHub issue of the project's repository, so records and locks match. */
export function canonicalKey(source, key, access) {
  if (source !== "github") return key;
  const [, owner, repo, number] = GITHUB_KEY.exec(key);
  return owner.toLowerCase() === access.owner.toLowerCase() &&
    repo.toLowerCase() === access.repo.toLowerCase()
    ? `${access.owner}/${access.repo}#${number}`
    : key;
}

export const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function startInput(input) {
  const invalid = () => problem(copy.invalidStart);
  if (!plainObject(input)) throw invalid();
  const { source, key, kind, again } = input;
  if (!TICKET_SOURCE_IDS.includes(source)) throw invalid();
  if (kind !== "session" && kind !== "pipeline") throw invalid();
  if (
    typeof key !== "string" ||
    !(source === "github" ? GITHUB_KEY : PLANE_KEY).test(key)
  )
    throw invalid();
  if (again !== undefined && typeof again !== "boolean") throw invalid();
  const checked = { source, key, kind, again: again === true };
  if (kind === "session") {
    const session = input.session ?? {};
    if (!plainObject(session)) throw invalid();
    // The project decides the folder; the server alone hands over the ticket.
    const { cwd: _cwd, ticket: _ticket, ...rest } = session;
    checked.session = rest;
  } else {
    const pipeline = input.pipeline;
    if (!plainObject(pipeline) || typeof pipeline.pipelineId !== "string")
      throw invalid();
    checked.pipeline = { pipelineId: pipeline.pipelineId };
    if (pipeline.baseBranch !== undefined) {
      if (
        typeof pipeline.baseBranch !== "string" ||
        !pipeline.baseBranch ||
        pipeline.baseBranch.length > 200 ||
        /[\x00-\x1f\x7f]/.test(pipeline.baseBranch)
      )
        throw invalid();
      checked.pipeline.baseBranch = pipeline.baseBranch;
    }
    if (pipeline.tokenBudget !== undefined) {
      if (
        !Number.isSafeInteger(pipeline.tokenBudget) ||
        pipeline.tokenBudget < 1 ||
        pipeline.tokenBudget > MAX_TOKEN_BUDGET
      )
        throw invalid();
      checked.pipeline.tokenBudget = pipeline.tokenBudget;
    }
  }
  return checked;
}

/** Repair-session settings of a pipeline sequence: a small allowlist of plain values. */
function repairInput(value, invalid) {
  if (!plainObject(value)) throw invalid();
  const out = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      !REPAIR_KEYS.includes(name) ||
      typeof entry !== "string" ||
      entry.length > 300 ||
      /[\x00-\x1f\x7f]/.test(entry)
    )
      throw invalid();
    out[name] = entry;
  }
  if (out.tool !== undefined && !isCodingCli(out.tool)) throw invalid();
  if (
    out.launchMode !== undefined &&
    (!out.tool || !Object.hasOwn(cliDefinition(out.tool).launchModes, out.launchMode))
  )
    throw invalid();
  return out;
}

/**
 * The settings shared by every ticket of a sequence or rule: kind, merge permission and
 * the session, pipeline and repair choices. `invalid` makes the caller's problem.
 */
export function sequenceOptionsInput(input, invalid) {
  if (!plainObject(input)) throw invalid();
  const { kind, allowMerge } = input;
  if (typeof allowMerge !== "boolean") throw invalid();
  if (input.repair !== undefined && kind !== "pipeline") throw invalid();
  let body;
  try {
    body = startInput({ ...input, source: TICKET_SOURCE_IDS[0], key: "o/r#1" });
  } catch {
    throw invalid();
  }
  const out = { kind: body.kind, allowMerge };
  if (body.session) out.session = body.session;
  if (body.pipeline) out.pipeline = body.pipeline;
  if (input.repair !== undefined) out.repair = repairInput(input.repair, invalid);
  return out;
}

/** The body of "start these tickets as a sequence", checked once for the whole list. */
export function sequenceInput(input) {
  const invalid = () => problem(copy.invalidSequence);
  if (!plainObject(input)) throw invalid();
  const { tickets, again } = input;
  if (!Array.isArray(tickets) || tickets.length < 1 || tickets.length > MAX_TICKETS)
    throw invalid();
  if (again !== undefined && typeof again !== "boolean") throw invalid();
  const options = sequenceOptionsInput(input, invalid);
  const seen = new Set();
  const listed = [];
  for (const entry of tickets) {
    if (!plainObject(entry)) throw invalid();
    let checked;
    try {
      checked = startInput({ ...input, source: entry.source, key: entry.key });
    } catch {
      throw invalid();
    }
    const id = `${checked.source}\n${checked.key}`;
    if (seen.has(id)) throw invalid();
    seen.add(id);
    listed.push({ source: checked.source, key: checked.key });
  }
  return { tickets: listed, ...options, again: again === true };
}
