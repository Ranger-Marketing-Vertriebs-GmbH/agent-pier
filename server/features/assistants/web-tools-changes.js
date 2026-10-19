import { detectBrowser } from "./browser-detection.js";
import { restartRequired } from "./assistant-provider-synchronization.js";
import { temporaryMember } from "./team-presentation.js";
import { webToolsSignature } from "./openclaw-config/web-tools.js";

/**
 * The global web tool sections (the tools.allow additions, tools.web, the search
 * plugin and the browser block) exist only in the startup configuration: under the
 * team plugin's restrictive plugins.allow the Gateway refuses them live. A save that
 * would compile other sections than the running Gateway was started with therefore
 * restarts it in maintenance, after the owner confirmed, like a provider change.
 * Everything else, including the agent's own entry, keeps applying live.
 */
export class WebToolsChanges {
  // `images()` is `{ ready }`: whether a ChatGPT account can create images now.
  // `pdfModel` is the owner's PDF model choice (pdf-model-settings.js).
  constructor({
    assistants,
    webSearch,
    synchronization,
    detect = detectBrowser,
    images = () => ({ ready: false }),
    pdfModel = null,
  }) {
    Object.assign(this, {
      assistants,
      webSearch,
      synchronization,
      detect,
      images,
      pdfModel,
    });
  }
  /** What a start compiles for PDF reading: `{ ready, connectionId, modelId }`. */
  pdf() {
    return this.pdfModel?.resolve() || { ready: false };
  }
  /**
   * True when the running Gateway was started with other global sections than
   * `profiles` and `search` compile now. A stopped Gateway compiles them at its next
   * start, so nothing needs a restart then.
   */
  differs({
    profiles = this.assistants.store.listAssistants(),
    search = this.webSearch.resolve(),
    pdf = this.pdf(),
  } = {}) {
    const runtime = this.assistants.runtime;
    const running = runtime.client?.ready && runtime.webTools;
    if (!running) return false;
    // A restart detects the browser again, so the comparison does as well.
    const webTools = {
      search,
      browser: this.detect(),
      searchPlugins: running.searchPlugins,
      documentExtract: running.documentExtract,
      images: this.images(),
      pdf,
    };
    return webToolsSignature({ profiles, webTools }) !== running.signature;
  }
  /** The profiles once `patch` is saved for `id`, as the store merges capabilities. */
  profilesWith(id, patch) {
    return this.assistants.store.listAssistants().map((profile) =>
      profile.id === id && (patch.capabilities || "browserVisible" in patch)
        ? {
            ...profile,
            ...("browserVisible" in patch && { browserVisible: patch.browserVisible }),
            capabilities: { ...profile.capabilities, ...patch.capabilities },
          }
        : profile,
    );
  }
  /** Agents the owner knows by name, plus a count of temporary team members. */
  usage() {
    const profiles = this.assistants.store.listAssistants().filter((p) => !p.archivedAt);
    return {
      agents: profiles
        .filter((p) => !temporaryMember(p))
        .map(({ id, name }) => ({ id, name })),
      teamMembers: profiles.filter(temporaryMember).length,
    };
  }
  /** Refuses without the owner's confirmation; nothing is persisted then. */
  confirm(confirmed) {
    if (!confirmed) throw restartRequired("webToolsRestartRequired", this.usage());
  }
  /**
   * Persists `operation` in maintenance and restarts the Gateway with its result.
   * `beforeChange` runs once no blocker can refuse, while the Gateway still runs.
   */
  restart(operation, { beforeChange } = {}) {
    return this.synchronization.restartGateway(operation, { beforeChange });
  }
  /** Saves the web search settings; a changed provider or key restarts the Gateway. */
  async saveSearch(input, { confirmed = false } = {}) {
    if (!this.differs({ search: this.webSearch.preview(input) }))
      return this.webSearch.save(input);
    this.confirm(confirmed);
    return this.restart(() => this.webSearch.save(input));
  }
  /** Saves the PDF model; a change for agents that read PDFs restarts the Gateway. */
  async savePdfModel(input, { confirmed = false } = {}) {
    if (!this.differs({ pdf: this.pdfModel.preview(input) }))
      return this.pdfModel.save(input);
    this.confirm(confirmed);
    return this.restart(() => this.pdfModel.save(input));
  }
}
