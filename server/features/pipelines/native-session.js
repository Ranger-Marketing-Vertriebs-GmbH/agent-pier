import { serverMessages } from "../../lib/i18n/de.js";
import { validId, textInput } from "../sessions/session-validation.js";
import { problem } from "../../lib/storage.js";

export function pipelineIdentity(value) {
  if (!value) return undefined;
  const result = {};
  for (const key of ["runId", "nodeId", "attemptId", "turnId"])
    result[key] = validId(value[key]);
  if (value.headless !== true) throw problem(serverMessages.pipelines.invalidSessionMode);
  return { ...result, headless: true };
}
export function nativeInput(options) {
  if (options.initialInput === undefined && !options.nativeObservation) return {};
  textInput(options.initialInput);
  if (options.nativeObservation && !options.pipeline?.headless)
    throw problem(serverMessages.pipelines.observationRequiresTurn);
  return { initialInput: options.initialInput };
}
export function assertInteractiveSession(session) {
  if (session.pipeline?.headless)
    throw problem(serverMessages.pipelines.useFeedbackControls, 409);
}
