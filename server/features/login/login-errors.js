import { problem } from "../../lib/storage.js";
import { loginMessages as copy } from "../../lib/i18n/de/login.js";

export const loginErrors = Object.freeze({
  LOGIN_ALREADY_CONFIGURED: { message: copy.exists, status: 409 },
  LOGIN_USERNAME_INVALID: { message: copy.username, status: 400 },
  LOGIN_PASSWORD_INVALID: { message: copy.password, status: 400 },
  LOGIN_CREDENTIALS_INVALID: { message: copy.invalid, status: 401 },
  LOGIN_THROTTLED: { message: copy.throttled, status: 429 },
  LOGIN_REQUIRED: { message: copy.required, status: 401 },
});

export function loginProblem(code) {
  const { message, status } = loginErrors[code];
  return Object.assign(problem(message, status), { code });
}
