import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { loginErrors, loginProblem } from "../login/login-errors.js";

const errors = Object.freeze({
  USER_NOT_FOUND: ["notFound", 404],
  USER_NAME_TAKEN: ["nameTaken", 409],
  USER_DISPLAY_NAME_INVALID: ["displayNameInvalid", 400],
  USER_PASSWORD_WRONG: ["passwordWrong", 400],
  USER_CHANGE_INVALID: ["changeInvalid", 400],
  USER_AGENT_ACCESS_INVALID: ["agentAccessInvalid", 400],
  USER_AGENT_REQUIRED: ["agentRequired", 409],
  USER_AGENT_OWN_FIXED: ["agentOwnFixed", 409],
  USER_LEVEL: ["level", 403],
  USER_AGENTS_CHOICE: ["agentsChoice", 400],
  USER_AGENTS_KEEP_PRIVATE: ["agentsKeepPrivate", 409],
  USER_AGENTS_OFF: ["agentsOff", 503],
});

export function userProblem(code) {
  if (Object.hasOwn(loginErrors, code)) return loginProblem(code);
  const [key, status] = errors[code];
  return Object.assign(problem(serverMessages.users[key], status), { code });
}
