import { detectBrowser } from "./browser-detection.js";
import { restartRequired } from "./assistant-provider-synchronization.js";
import { temporaryMember } from "./team-presentation.js";
import { webToolsSignatures } from "./openclaw-config/web-tools.js";
import { usedCapabilities } from "./native-capabilities.js";

/**
 * The global web tool sections (the tools.allow additions, tools.web, the search
 * plugin, PDF extraction and the browser block) exist only in the startup
 * configuration: under the team plugin's restrictive plugins.allow the Gateway does
 * not take them live. A start compiles every one the runtime can serve, so an agent
 * switching a capability changes only its own entry and browser profile, which apply
 * live. Only a save that changes what a used capability compiles (another search
 * provider or key, PDF model, a browser found or gone) needs a Gateway restart.
 */
export class WebToolsChanges {
  // `images()` is `{ ready }`: whether a ChatGPT account can create images now.
  // `pdfModel` is the owner's optional PDF fallback (pdf-model-settings.js).
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
   * `search` and `pdf` compile now, for a capability `profiles` use (or one of
   * `keys`). A stopped Gateway compiles them at its next start, so nothing needs a
   * restart then.
   */
  differs({
    profiles = this.assistants.store.listAssistants(),
    search = this.webSearch.resolve(),
    pdf = this.pdf(),
    keys = [...usedCapabilities(profiles)],
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
    const now = webToolsSignatures({ webTools });
    return keys.some((key) => key in now && now[key] !== running.signatures?.[key]);
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
  /**
   * The app's pending restart (pending-restart.js): a change that needs a restart is
   * saved at once and the restart runs as soon as nothing is busy. Without one
   * (tools, tests) the owner confirms an immediate restart instead.
   */
  get pending() {
    return this.synchronization?.pending || null;
  }
  /** Records the restart a change saved meanwhile needs, for `reason`. */
  queue(reason = "webTools") {
    return this.pending?.request(reason, this.usage());
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
  /** Saves the web search settings; a changed provider or key needs a restart. */
  async saveSearch(input, { confirmed = false } = {}) {
    if (!this.differs({ search: this.webSearch.preview(input) }))
      return this.webSearch.save(input);
    if (this.pending) {
      const saved = this.webSearch.save(input);
      this.queue("webSearch");
      return saved;
    }
    this.confirm(confirmed);
    return this.restart(() => this.webSearch.save(input));
  }
  /** Saves the PDF model; a change for agents that read PDFs needs a restart. */
  async savePdfModel(input, { confirmed = false } = {}) {
    if (!this.differs({ pdf: this.pdfModel.preview(input) }))
      return this.pdfModel.save(input);
    if (this.pending) {
      const saved = this.pdfModel.save(input);
      this.queue("pdfModel");
      return saved;
    }
    this.confirm(confirmed);
    return this.restart(() => this.pdfModel.save(input));
  }
}
