// What a failed native stage turn tells the owner: the CLI's own error text (already
// redacted by native-events.js) and, when the CLI could not sign in, where to fix it.
import { serverMessages } from "../../lib/i18n/de.js";

// Sign-in failures as Claude Code, Codex and OpenCode word them.
const signIn =
  /not logged in|\/login\b|invalid api key|oauth token has expired|\b401\b|unauthori[sz]ed|authentication_error|please (?:log|sign) ?in/i;

export function nativeFailureText(outcome) {
  const messages = serverMessages.pipelines;
  const error = outcome?.error;
  if (!error) return messages.nativeTurnFailed;
  return signIn.test(error)
    ? messages.nativeTurnSignInFailed(error)
    : messages.nativeTurnFailedWith(error);
}
