import { personalCapabilities } from "./native-capabilities.js";

const keys = new Set(["agentId", "sessionKey"]);
const refuse = (reason) => ({ allow: false, reason });
const account = (connectionId) => connectionId.startsWith("openclaw:");

/**
 * The identity of a PDF fallback selection (`{ connectionId, modelId }`): a Hermes
 * home carries the one it was compiled with, and its pdf tool sends a PDF to that
 * fallback only while reader() names the same one.
 */
export const pdfFallbackId = (selection) =>
  selection ? `${selection.connectionId}\n${selection.modelId}` : null;

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
 *
 * A Hermes agent reads with AgentPier's own `pdf` tool (runtimes/hermes/hermes-config/
 * pdf.js), which asks reader() through the Hermes guard (hermes-tool-guard.js): the
 * same decision, named as the reader rather than a Gateway model reference, with the
 * fallback as the owner's setting names it now (`settings`: pdf-model-settings.js),
 * since each change applies the Hermes homes that read PDFs.
 */
export class PdfPolicy {
  constructor({ assistants, settings = null }) {
    this.assistants = assistants;
    this.settings = settings;
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
  /**
   * `{ allow: true, model, reader }` or a refusal; `reader` is "own" (the agent's own
   * model, which takes images), "fallback" (`fallback`, a truthy model reference) or
   * "text" (the agent's own text-only model).
   */
  async decide(input, fallback) {
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
      return own ? { allow: true, model: own, reader: "own" } : refuse("unavailable");
    if (fallback) return { allow: true, model: fallback, reader: "fallback" };
    if (own) return { allow: true, model: own, reader: "text" };
    return refuse("unavailable");
  }
  /** OpenClaw's pdf hook: the Gateway model reference that reads, or a refusal. */
  async check(input) {
    // A fallback saved since the start waits for its restart (web-tools-changes.js).
    const started = this.assistants.providerSynchronization?.pdfFallback;
    const { reader: _reader, ...answer } = await this.decide(
      input,
      typeof started === "string" && started ? started : null,
    );
    return answer;
  }
  /** The owner's fallback selection now (`{ connectionId, modelId }`), or null. */
  fallback() {
    try {
      return this.settings?.selection() ?? null;
    } catch {
      return null;
    }
  }
  /**
   * The Hermes pdf tool's answer: `{ allow: true, reader }`, with `fallback`, the
   * fallback's identity (pdfFallbackId), when it reads; or a refusal.
   */
  async reader(input) {
    const fallback = pdfFallbackId(this.fallback());
    const answer = await this.decide(input, fallback);
    if (!answer.allow) return answer;
    return {
      allow: true,
      reader: answer.reader,
      ...(answer.reader === "fallback" && { fallback }),
    };
  }
}
