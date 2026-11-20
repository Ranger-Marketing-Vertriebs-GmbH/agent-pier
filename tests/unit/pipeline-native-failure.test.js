import test from "node:test";
import assert from "node:assert/strict";
import { reduceNativeEvent } from "../../server/features/pipelines/native-events.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { nativeFailureText } from "../../server/features/pipelines/native-failure.js";

const claudeResult = (fields) => ({
  type: "result",
  session_id: "native-1",
  is_error: true,
  subtype: "success",
  ...fields,
});

test("a failed Claude result reports its result text, not its subtype", () => {
  const state = reduceNativeEvent(
    "claude",
    {},
    claudeResult({ result: "Not logged in · Please run /login" }),
  );
  assert.equal(state.result, "failed");
  assert.equal(state.error, "Not logged in · Please run /login");
});

test("the failure text is redacted", () => {
  const state = reduceNativeEvent(
    "claude",
    {},
    claudeResult({ result: "Request failed for key sk-abcdefghijklmnopqrstuvwx" }),
  );
  assert.doesNotMatch(state.error, /sk-abcdefghijklmnop/);
  assert.match(state.error, /•••/);
});

test("the subtype only names a failure without any text", () => {
  const state = reduceNativeEvent(
    "claude",
    {},
    claudeResult({ subtype: "error_max_turns" }),
  );
  assert.equal(state.error, "error_max_turns");
  assert.equal(
    reduceNativeEvent("claude", {}, claudeResult({})).error,
    "The native CLI reported an error.",
  );
});

test("a sign-in failure gets a hint to sign the account in again", () => {
  const messages = serverMessages.pipelines;
  for (const error of [
    "Not logged in · Please run /login",
    "Invalid API key · Please run /login",
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Error: 401 Unauthorized",
    "authentication_error: invalid x-api-key",
  ])
    assert.equal(nativeFailureText({ error }), messages.nativeTurnSignInFailed(error));
  assert.equal(
    nativeFailureText({ error: "Disk full" }),
    messages.nativeTurnFailedWith("Disk full"),
  );
  assert.equal(nativeFailureText({}), messages.nativeTurnFailed);
});

test("the sign-in text is traced back to its English catalog entry", async () => {
  const { agentText } = await import("../../server/lib/i18n/agent-text.js");
  const { englishServerMessages } = await import("../../server/lib/i18n/catalog-en.js");
  const error = "Not logged in · Please run /login";
  assert.equal(
    agentText(serverMessages.pipelines.nativeTurnSignInFailed(error)),
    englishServerMessages.pipelines.nativeTurnSignInFailed(error),
  );
  assert.equal(
    agentText(serverMessages.pipelines.nativeTurnFailedWith("Disk full")),
    englishServerMessages.pipelines.nativeTurnFailedWith("Disk full"),
  );
});
