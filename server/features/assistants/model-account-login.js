import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assistantProblem } from "./assistant-validation.js";
import { chatgptLoginUrl, deviceLoginMs } from "../model-logins/chatgpt-auth.js";
const active = new Set(["starting", "awaiting_user"]);
// A failure this flow diagnosed itself, as opposed to a network or upstream error.
const diagnosedCodes = new Set([
  "LOGIN_UNAVAILABLE",
  "LOGIN_FAILED",
  "LOGIN_EXPIRED",
  "UNSUPPORTED_LOGIN_STEP",
  "NETWORK",
]);

/**
 * A reason for the log: no device code, bearer value or token-like run survives,
 * and control characters are dropped.
 */
export function loginReason(text, code) {
  if (typeof text !== "string" || !text) return "";
  let result = text;
  if (code) result = result.split(code).join("[redacted]");
  return result
    .replace(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/g, "[redacted]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{24,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .slice(0, 300);
}

/**
 * The owner's ChatGPT sign-in, run by AgentPier itself: OpenAI's device-code flow
 * (model-logins/chatgpt-auth.js), its tokens kept in AgentPier's vault
 * (model-logins/chatgpt-vault.js), the only refresher. No runtime takes part, so
 * a sign-in works while OpenClaw is stopped; `accounts.signedIn(profileId)` then
 * hands the runtimes their access (model-accounts.js).
 */
export class AssistantAccountLogin {
  constructor({ accounts, vault, auth = vault?.auth, warn = console.warn }) {
    Object.assign(this, { accounts, vault, auth, warn });
    // Called after every change of the attempt status() reports (assigned by the
    // wiring: the live `job.chatgpt-login` topic).
    this.onChange = null;
  }
  /** Calls `onChange()`; a failing listener is logged, never thrown. */
  changed() {
    try {
      this.onChange?.();
    } catch {
      console.error("AgentPier could not announce the ChatGPT sign-in.");
    }
  }
  // Marks an active attempt failed and logs why; the browser only gets the code.
  fail(attempt, diagnostic, error) {
    if (!active.has(attempt.status)) return;
    attempt.status = "failed";
    attempt.diagnostic = diagnostic;
    attempt.abort.abort();
    this.changed();
    const details = [
      Number.isInteger(error?.status) && `HTTP ${error.status}`,
      loginReason(error?.reason, attempt.code),
    ].filter(Boolean);
    this.warn(
      `ChatGPT sign-in failed: ${diagnostic}${details.length ? ` (${details.join(": ")})` : ""}`,
    );
  }
  status(id = this.attempt?.id) {
    if (!this.attempt || id !== this.attempt.id) throw assistantProblem("notFound", 404);
    const { id: attemptId, status, code, url, expiresAt, diagnostic } = this.attempt;
    return {
      id: attemptId,
      status,
      ...(active.has(status) && code ? { code, url, expiresAt } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  start() {
    if (this.attempt && active.has(this.attempt.status)) return this.status();
    if (!this.vault || !this.auth) throw assistantProblem("unavailable", 503);
    const attempt = (this.attempt = {
      id: randomUUID(),
      status: "starting",
      // Since when it waits, for the runtime update's blocker list.
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
    });
    this.changed();
    attempt.task = this.run(attempt);
    return this.status();
  }
  async run(attempt) {
    const { signal } = attempt.abort;
    const current = () => this.attempt === attempt && active.has(attempt.status);
    try {
      const device = await this.auth.startDevice({ signal });
      if (!current()) return;
      const deadline = Date.now() + deviceLoginMs;
      Object.assign(attempt, {
        code: device.userCode,
        url: chatgptLoginUrl,
        expiresAt: new Date(deadline).toISOString(),
        status: "awaiting_user",
      });
      this.changed();
      let tokens = null;
      while (!tokens) {
        await delay(device.intervalMs, undefined, { signal });
        if (!current()) return;
        if (Date.now() > deadline)
          throw Object.assign(Error(), { code: "LOGIN_EXPIRED" });
        // A network hiccup while the owner confirms is retried at the next poll.
        tokens = await this.auth.pollDevice({ ...device, signal }).catch((error) => {
          if (error?.code === "NETWORK") return null;
          throw error;
        });
        if (!current()) return;
      }
      // Saved before anything uses it: from here on AgentPier holds the login.
      const profileId = this.vault.save(tokens);
      await this.accounts
        .signedIn?.(profileId)
        .catch(() =>
          this.warn("The new ChatGPT login reaches the runtimes at their next start."),
        );
      if (!current()) return;
      attempt.status = "completed";
      this.changed();
    } catch (error) {
      if (!current()) return;
      this.fail(
        attempt,
        diagnosedCodes.has(error?.code) ? error.code : "LOGIN_FAILED",
        error,
      );
    }
  }
  async cancel(id) {
    this.status(id);
    const attempt = this.attempt;
    if (active.has(attempt.status)) {
      attempt.status = "cancelled";
      attempt.abort.abort();
      this.changed();
    }
    return this.status(id);
  }
  async close() {
    if (this.attempt) await this.cancel(this.attempt.id);
  }
}
