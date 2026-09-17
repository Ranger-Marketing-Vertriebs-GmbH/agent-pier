import { problem } from "../../lib/storage.js";

export function sshProblem(code, message, status = 400) {
  return Object.assign(problem(message, status), { code });
}

export function publicSshError(error) {
  return {
    code: /^SSH_[A-Z_]+$/.test(error?.code || "") ? error.code : "SSH_OPERATION_FAILED",
    error: error?.status ? error.message : "SSH operation failed.",
    status: error?.status || 500,
  };
}
