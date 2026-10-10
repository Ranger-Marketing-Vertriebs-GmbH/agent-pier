import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assistantProblem } from "./assistant-validation.js";
const active = new Set(["starting", "awaiting_user"]);
const loginUrl = "https://auth.openai.com/codex/device";
export class AssistantAccountLogin {
  constructor({ runtime, accounts }) {
    Object.assign(this, { runtime, accounts });
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
    const disconnected = () => {
      attempt.status = "failed";
      attempt.diagnostic = "CONNECTION_LOST";
    };
    client.once("disconnected", disconnected);
    const current = () =>
      this.attempt === attempt &&
      active.has(attempt.status) &&
      this.runtime.client === client &&
      client.ready;
    try {
      await client.call(
        "models.authLogin",
        {
          sessionId: attempt.id,
          agentId: "main",
          authChoice: "openai/openai-device-code",
        },
        { timeoutMs: 60000 },
      );
      let answer;
      const deadline = Date.now() + 15 * 60 * 1000;
      while (current()) {
        if (Date.now() > deadline)
          throw Object.assign(Error(), { code: "LOGIN_EXPIRED" });
        const result = await client.call(
          "wizard.next",
          { sessionId: attempt.id, ...(answer ? { answer } : {}) },
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        if (!current()) return;
        answer = undefined;
        if (result.done) {
          if (result.status !== "done")
            throw Object.assign(Error(), { code: "LOGIN_FAILED" });
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
          throw Object.assign(Error(), { code: "UNSUPPORTED_LOGIN_STEP" });
        if (step.externalUrl) {
          if (step.externalUrl !== loginUrl)
            throw Object.assign(Error(), { code: "UNSUPPORTED_LOGIN_STEP" });
          attempt.url = loginUrl;
        }
        if (step.deviceCode) {
          if (!/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(step.deviceCode.code))
            throw Object.assign(Error(), { code: "UNSUPPORTED_LOGIN_STEP" });
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
        else throw Object.assign(Error(), { code: "UNSUPPORTED_LOGIN_STEP" });
      }
    } catch (error) {
      if (active.has(attempt.status)) {
        attempt.status = "failed";
        attempt.diagnostic = ["UNSUPPORTED_LOGIN_STEP", "LOGIN_EXPIRED"].includes(
          error.code,
        )
          ? error.code
          : "LOGIN_FAILED";
      }
    } finally {
      if (active.has(attempt.status)) {
        attempt.status = "failed";
        attempt.diagnostic = "CONNECTION_LOST";
      }
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
