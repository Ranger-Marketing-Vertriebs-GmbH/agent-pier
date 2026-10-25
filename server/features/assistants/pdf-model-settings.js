import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { assistantProblem } from "./assistant-validation.js";
import { PdfPolicy } from "./pdf-policy.js";

const account = (connectionId) => connectionId.startsWith("openclaw:");

/**
 * The owner's optional PDF fallback model. Agents read PDFs with their own model when
 * it accepts images; this model reads them for agents whose model does not
 * (pdf-policy.js). Without a usable fallback those agents read the PDF's text only.
 * OpenClaw's `pdf` tool takes a model only from the global agents.defaults.pdfModel
 * (an agent entry cannot name one, verified on 2026.10.7), which a start compiles
 * from this choice or, without one, a placeholder that never resolves. Only ids are
 * stored here: the connection's key stays with the model connection and reaches only
 * openclaw.json (AssistantProviderSynchronization.prepare). A model without image
 * input is allowed: it reads the PDF text, not scanned pages.
 */
export class PdfModelSettings {
  // `models` is AssistantModels: the same connections and accounts agents choose from.
  constructor({ dataDir, models }) {
    this.models = models;
    this.db = privateDatabase(path.join(dataDir, "assistants"), "pdf-model.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, connection_id TEXT, model_id TEXT); INSERT OR IGNORE INTO settings VALUES (1,0,NULL,NULL);",
    );
  }
  row() {
    return this.db.prepare("SELECT * FROM settings WHERE id=1").get();
  }
  /**
   * Why `connectionId`/`modelId` cannot read PDFs now, or null when it can. A ChatGPT
   * account counts while it is signed in, also while the Gateway is stopped: a start
   * compiles it before the Gateway runs.
   */
  problem(connectionId, modelId) {
    if (!connectionId || !modelId) return "notSet";
    let listed;
    try {
      listed = this.models.listCapabilities().find((c) => c.id === connectionId);
    } catch {
      listed = null;
    }
    if (!listed) return "connectionMissing";
    if (account(connectionId) ? !listed.signedIn : !listed.available)
      return "connectionUnavailable";
    return null;
  }
  /**
   * Whether the model takes images: true, false, or null when unknown. A text-only
   * model still reads PDFs: OpenClaw sends it the extracted text and drops the page
   * images, so only pages without text (scans) stay unreadable.
   */
  images(connectionId, modelId) {
    if (!connectionId || !modelId) return null;
    try {
      const images = this.models.imageInput({ connectionId, modelId });
      return typeof images === "boolean" ? images : null;
    } catch {
      return null;
    }
  }
  get() {
    const row = this.row();
    const reason = this.problem(row.connection_id, row.model_id);
    return {
      revision: row.revision,
      ...(row.connection_id && { connectionId: row.connection_id }),
      ...(row.model_id && { modelId: row.model_id }),
      ...(row.connection_id && { images: this.images(row.connection_id, row.model_id) }),
      ready: !reason,
      ...(reason && { reason }),
    };
  }
  /** The bridge's answer to the plugin's pdf hook (pdf-policy.js). */
  policy(assistants) {
    return new PdfPolicy({ assistants });
  }
  /** The compiler's view: `{ ready, connectionId, modelId }`, ids only. */
  resolve() {
    const row = this.row();
    return this.resolved(row.connection_id, row.model_id);
  }
  resolved(connectionId, modelId) {
    return !connectionId || this.problem(connectionId, modelId)
      ? { ready: false }
      : { ready: true, connectionId, modelId };
  }
  /** The selection a start resolves into agents.defaults.pdfModel, or null. */
  selection() {
    const { ready, connectionId, modelId } = this.resolve();
    return ready ? { connectionId, modelId } : null;
  }
  validate(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["revision", "connectionId", "modelId"].includes(k))
    )
      throw assistantProblem("invalid");
    const { revision, connectionId = null, modelId = null } = input;
    const text = (value) =>
      typeof value === "string" && !!value.trim() && value.length <= 256;
    if (
      !Number.isInteger(revision) ||
      (connectionId !== null && !text(connectionId)) ||
      (modelId !== null && !text(modelId)) ||
      // A model belongs to a connection; clearing clears both.
      (connectionId === null) !== (modelId === null)
    )
      throw assistantProblem("invalid");
    if (revision !== this.row().revision) throw assistantProblem("conflict", 409);
    if (connectionId) {
      if (this.problem(connectionId, modelId)) throw assistantProblem("provider");
    }
    return { revision, connectionId, modelId };
  }
  /** What resolve() would return once `input` is saved; validates like save(). */
  preview(input) {
    const { connectionId, modelId } = this.validate(input);
    return this.resolved(connectionId, modelId);
  }
  save(input) {
    const { revision, connectionId, modelId } = this.validate(input);
    const changed = this.db
      .prepare(
        "UPDATE settings SET revision=revision+1,connection_id=?,model_id=? WHERE id=1 AND revision=?",
      )
      .run(connectionId, modelId, revision);
    if (!changed.changes) throw assistantProblem("conflict", 409);
    return this.get();
  }
  close() {
    this.db.close();
  }
}
