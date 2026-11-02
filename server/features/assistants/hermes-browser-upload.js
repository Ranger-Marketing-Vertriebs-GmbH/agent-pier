import { assistantProblem, textValue } from "./assistant-validation.js";
import { browserRefusals } from "./team-plugin/tool-guard.js";
import { browserUploadDone } from "./agent-browser-uploads.js";
import { runtimeFor, runtimeIdOf } from "./runtimes/runtime-for.js";

// Why a Hermes browser upload did not fill the field, for the model.
export const hermesUploadRefusals = {
  BROWSER_NO_TAB:
    "No open page matches. Open the page first, or name it with urlContains.",
  BROWSER_TAB_AMBIGUOUS:
    "Several pages are open. Name the page with urlContains (part of its address).",
  BROWSER_NO_ELEMENT: "No element on the page matches the selector.",
  BROWSER_NOT_FILE_INPUT: "The selector does not name a file field (input type=file).",
  BROWSER_NOT_RUNNING: browserRefusals.unavailable,
};

/**
 * The Hermes team plugin's `agentpier_browser_upload` (`/hermes-browser-upload`):
 * fills a file field in the calling Hermes agent's AgentPier-owned Chromium with
 * files AgentPier staged for it (agentpier_workspace browser_upload_stage), since
 * Hermes's own browser tools offer no upload. The call passes the same checks as
 * OpenClaw's browser upload (TeamBridge.browserPolicy: the agent's browser limits,
 * then only its own staged files, browser-upload-staging.js admit), sets the files
 * over CDP (hermes-browser-files.js) and is audited like OpenClaw's
 * (browserUploadDone). `input`: `{ agentId, sessionKey?, paths, selector?,
 * urlContains? }`. Answers `{ ok, files, url }` or `{ ok: false, message }`.
 */
export async function hermesBrowserUpload(bridge, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) => !["agentId", "sessionKey", "paths", "selector", "urlContains"].includes(k),
    ) ||
    !Array.isArray(input.paths) ||
    !input.paths.length ||
    input.paths.length > 20
  )
    throw assistantProblem("invalid");
  textValue(input.agentId, 512);
  if (input.sessionKey !== undefined) textValue(input.sessionKey, 4096);
  for (const file of input.paths) textValue(file, 4096);
  const selector = input.selector ?? 'input[type="file"]';
  textValue(selector, 1000);
  if (input.urlContains !== undefined) textValue(input.urlContains, 2000);
  const refuse = (message) => ({ ok: false, message });
  const agent = bridge.agentOf(input.agentId);
  if (bridge.closed || !agent || runtimeIdOf(agent) !== "hermes")
    return refuse(browserRefusals.unavailable);
  const session = input.sessionKey ? { sessionKey: input.sessionKey } : {};
  const policy = await bridge.browserPolicy({
    agentId: input.agentId,
    ...session,
    action: "upload",
    paths: input.paths,
  });
  if (!policy?.allow)
    return refuse(browserRefusals[policy?.reason] || browserRefusals.unavailable);
  let files = [];
  try {
    files = bridge.assistants.workflows.browserUploads.staging
      .owned(agent.id, input.paths)
      .map((entry) => entry.path);
  } catch {
    /* No staging: nothing was staged. */
  }
  if (files.length !== input.paths.length) return refuse(browserRefusals.uploadNotStaged);
  let result;
  try {
    result = await runtimeFor(agent, bridge.assistants.runtime).browser.request({
      method: "POST",
      path: "/set-files",
      body: { selector, files, urlContains: input.urlContains },
    });
  } catch (error) {
    browserUploadDone(bridge, {
      agentId: input.agentId,
      ...session,
      paths: input.paths,
      ok: false,
    });
    return refuse(hermesUploadRefusals[error?.code] || browserRefusals.unavailable);
  }
  browserUploadDone(bridge, {
    agentId: input.agentId,
    ...session,
    paths: input.paths,
    ok: true,
  });
  return { ok: true, files: files.length, url: result?.url ?? null };
}
