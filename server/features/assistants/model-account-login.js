import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assistantProblem } from "./assistant-validation.js";
const active = new Set(["starting", "awaiting_user"]);
const loginUrl = "https://auth.openai.com/codex/device";
// A failure this flow diagnosed itself, as opposed to a Gateway or transport error.
const failure = (code, details) =>
  Object.assign(Error(), { code, diagnosed: true, ...details });

/**
 * The Gateway's reason for the log: no device code, bearer value or token-like run
 * survives, and control characters are dropped.
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

export class AssistantAccountLogin {
  constructor({ runtime, accounts, warn = console.warn }) {
    Object.assign(this, { runtime, accounts, warn });
  }
  // Marks an active attempt failed and logs why; the browser only gets the code.
  fail(attempt, diagnostic, error) {
    if (!active.has(attempt.status)) return;
    attempt.status = "failed";
    attempt.diagnostic = diagnostic;
    const details = [
      /^[A-Z_]{1,60}$/.test(error?.gatewayCode) && `Gateway ${error.gatewayCode}`,
      error?.wizardStatus && `wizard ${error.wizardStatus}`,
      error?.stepType && `step ${loginReason(String(error.stepType)).slice(0, 40)}`,
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
      ...(active.has(status) ? { code, url, expiresAt } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  start() {
    if (this.attempt && active.has(this.attempt.status)) return this.status();
    if (!this.runtime.client?.ready) throw assistantProblem("unavailable", 503);
    const attempt = (this.attempt = {
      id: randomUUID(),
      status: "starting",
      client: this.runtime.client,
    });
    attempt.task = this.run(attempt);
    return this.status();
  }
  async run(attempt) {
    const client = attempt.client;
    const disconnected = () => this.fail(attempt, "CONNECTION_LOST");
    client.once("disconnected", disconnected);
    const current = () =>
      this.attempt === attempt &&
      active.has(attempt.status) &&
      this.runtime.client === client &&
      client.ready;
    try {
      await client
        .call(
          "models.authLogin",
          {
            sessionId: attempt.id,
            agentId: "main",
            authChoice: "openai/openai-device-code",
          },
          { timeoutMs: 60000 },
        )
        .catch((error) => {
          // An answered INVALID_REQUEST: the Gateway does not offer this login, for
          // example when its plugin allow list leaves out the OpenAI provider.
          throw failure(
            error.answered && error.code === "INVALID_REQUEST"
              ? "LOGIN_UNAVAILABLE"
              : "LOGIN_FAILED",
            { gatewayCode: error.code, reason: error.remoteMessage },
          );
        });
      let answer;
      const deadline = Date.now() + 15 * 60 * 1000;
      while (current()) {
        if (Date.now() > deadline) throw failure("LOGIN_EXPIRED");
        const result = await client.call(
          "wizard.next",
          { sessionId: attempt.id, ...(answer ? { answer } : {}) },
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        if (!current()) return;
        answer = undefined;
        if (result.done) {
          if (result.status !== "done")
            throw failure("LOGIN_FAILED", {
              wizardStatus: String(result.status).slice(0, 40),
              reason: result.error,
            });
          await this.accounts.list();
          if (current()) attempt.status = "completed";
          return;
        }
        const step = result.step;
        if (!step) {
          await delay(250);
          continue;
        }
        if (step.sensitive)
          throw failure("UNSUPPORTED_LOGIN_STEP", { stepType: step.type });
        if (step.externalUrl) {
          if (step.externalUrl !== loginUrl)
            throw failure("UNSUPPORTED_LOGIN_STEP", { stepType: step.type });
          attempt.url = loginUrl;
        }
        if (step.deviceCode) {
          if (!/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(step.deviceCode.code))
            throw failure("UNSUPPORTED_LOGIN_STEP", { stepType: step.type });
          attempt.code = step.deviceCode.code;
          attempt.url = loginUrl;
          attempt.expiresAt = new Date(
            Date.now() + Math.min(step.deviceCode.expiresInMinutes || 15, 15) * 60000,
          ).toISOString();
          attempt.status = "awaiting_user";
        }
        if (step.type === "progress") {
          await delay(250);
          continue;
        }
        if (["note", "action"].includes(step.type)) answer = { stepId: step.id };
        else if (
          step.type === "select" &&
          step.initialValue === "keep" &&
          step.options?.some((o) => o.value === "keep")
        )
          answer = { stepId: step.id, value: "keep" };
        else throw failure("UNSUPPORTED_LOGIN_STEP", { stepType: step.type });
      }
    } catch (error) {
      if (error.diagnosed) this.fail(attempt, error.code, error);
      else
        this.fail(attempt, "LOGIN_FAILED", {
          gatewayCode: error.code,
          reason: error.remoteMessage,
        });
    } finally {
      this.fail(attempt, "CONNECTION_LOST");
      client.off("disconnected", disconnected);
      if (attempt.status !== "completed" && client.ready)
        await client
          .call(
            "wizard.cancel",
            { sessionId: attempt.id, closeInput: true },
            { timeoutMs: 2000 },
          )
          .catch(() => {});
    }
  }
  async cancel(id) {
    this.status(id);
    const attempt = this.attempt;
    if (active.has(attempt.status)) {
      attempt.status = "cancelled";
      await attempt.client
        .call("wizard.cancel", { sessionId: id, closeInput: true }, { timeoutMs: 2000 })
        .catch(() => {});
    }
    return this.status(id);
  }
  async close() {
    if (this.attempt) await this.cancel(this.attempt.id);
  }
}
