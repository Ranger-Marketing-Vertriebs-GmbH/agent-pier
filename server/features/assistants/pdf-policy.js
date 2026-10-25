import { personalCapabilities } from "./native-capabilities.js";

const keys = new Set(["agentId", "sessionKey"]);
const refuse = (reason) => ({ allow: false, reason });
const account = (connectionId) => connectionId.startsWith("openclaw:");

/**
 * AgentPier's answer to the plugin's pdf hook (tool-guard.js pdfCall): which model
 * reads this agent's PDF. OpenClaw takes a PDF model only from the global
 * agents.defaults.pdfModel (verified on 2026.10.7), so the guard sets `model` on every
 * call: the agent's own model when it accepts images, else the owner's fallback model
 * (pdf-model-settings.js) the running Gateway was started with
 * (AssistantProviderSynchronization.pdfFallback), else the agent's own text-only model,
 * which reads the PDF's text but not its page images. An own model that takes images
 * but is unusable right now refuses rather than falling back. An agent's own `model` argument
 * is never used. Refs are resolved like the start and a live apply resolve them, so
 * they name the providers the Gateway runs (assistant-models.js transport ids).
 */
export class PdfPolicy {
  constructor({ assistants }) {
    this.assistants = assistants;
  }
  /** The model reference the Gateway runs `model` ({ connectionId, modelId }) by, or null. */
  async ref(model) {
    const models = this.assistants.models;
    let lease;
    try {
      if (account(model.connectionId)) {
        const selected = models.accounts.offlineSelection(
          model.connectionId,
          model.modelId,
        );
        return selected.available ? selected.modelRef : null;
      }
      lease = await models.resolve(model);
      return lease.provider && lease.providerId ? lease.modelRef : null;
    } catch {
      return null;
    } finally {
      lease?.release?.();
    }
  }
  images(model) {
    try {
      return this.assistants.models.imageInput(model) === true;
    } catch {
      return false;
    }
  }
  async check(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !keys.has(key)) ||
      typeof input.agentId !== "string"
    )
      return refuse("unavailable");
    const agent = this.assistants.store
      .listAssistants()
      .find((profile) => profile.runtimeAgentId === input.agentId);
    if (!agent || agent.archivedAt || typeof agent.model?.connectionId !== "string")
      return refuse("unavailable");
    if (!personalCapabilities(agent).readPdfs) return refuse("notGranted");
    const own = await this.ref(agent.model);
    // An own model that takes images reads, or nothing does: while it is unusable the
    // PDF waits rather than reaching the owner's fallback.
    if (this.images(agent.model))
      return own ? { allow: true, model: own } : refuse("unavailable");
    // A fallback saved since the start waits for its restart (web-tools-changes.js).
    const fallback = this.assistants.providerSynchronization?.pdfFallback;
    if (typeof fallback === "string" && fallback) return { allow: true, model: fallback };
    if (own) return { allow: true, model: own };
    return refuse("unavailable");
  }
}
