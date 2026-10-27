import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { readSkillPackTracked, skillRequirements } from "../extensions/skill-packages.js";
import { SkillPreviews } from "../extensions/skill-previews.js";
import { contentHash } from "../extensions/skill-scan.js";

// Catalog previews belong to the owner; one fixed account id keeps them apart from
// the CLI profile previews of the same SkillPreviews code.
const ACCOUNT = "catalog";

const importKindOf = (input) =>
  input.url !== undefined ? "github" : input.fileName === "SKILL.md" ? "skill-md" : "zip";

/**
 * Installs and updates agent catalog skills through the scanned preview of
 * extensions. One skill per name: a source whose name is already in the catalog is
 * the next version of that skill (`replaces` in the preview). Rules the owner accepted
 * for the version being replaced need no new acceptance; a new warning rule or a block
 * does. Names that the runtime bundles (`bundledNames`), that another skill folder
 * already loads (`globalNames`) or that a running Gateway reports from a source other
 * than the catalog (`reportNames`, null without a Gateway) are refused at preview.
 * Writes run one after another.
 */
export class SkillCatalog {
  constructor({
    store,
    bundledNames = () => new Set(),
    globalNames = () => new Set(),
    reportNames = async () => null,
    fetchImpl = globalThis.fetch,
  }) {
    this.store = store;
    this.bundledNames = bundledNames;
    this.globalNames = globalNames;
    this.reportNames = reportNames;
    this.fetchImpl = fetchImpl;
    this.previews = new SkillPreviews();
    this.active = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  assertOpen() {
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
  }
  /** Refuses a name another skill source already uses (bundled, then global). */
  assertLocalName(name) {
    if (this.bundledNames().has(name))
      throw problem(serverMessages.extensions.catalogNameBundled, 409);
    if (this.globalNames().has(name))
      throw problem(serverMessages.extensions.catalogNameTaken, 409);
  }
  async assertFreeName(name) {
    this.assertLocalName(name);
    const reported = await this.reportNames();
    if (reported?.has(name))
      throw problem(serverMessages.extensions.catalogNameTaken, 409);
  }
  /** Runs `fn` after every earlier write has settled. */
  serialized(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }
  read(input) {
    return readSkillPackTracked(this.active, input, this.fetchImpl);
  }
  /** Scans `pack` and keeps it as a preview, as an update when its name is taken. */
  async previewPack(pack, importKind) {
    await this.assertFreeName(pack.name);
    this.assertOpen();
    const previous = this.store.byName(pack.name);
    const accepted = new Set(previous?.scan?.rules || []);
    return this.previews.create(ACCOUNT, pack, importKind, (scan) => ({
      ...(previous ? { replaces: { id: previous.id, version: previous.version } } : {}),
      newRules: scan.rules.filter((rule) => !accepted.has(rule)),
    }));
  }
  /** Reads and scans a source (nothing is written); confirmed through install. */
  async preview(input = {}) {
    this.assertOpen();
    const pack = await this.read(input);
    this.assertOpen();
    return this.previewPack(pack, importKindOf(input));
  }
  /**
   * Installs a confirmed preview exactly as scanned (see SkillPreviews.take). A preview
   * made before the catalog changed under its name must be checked again.
   */
  install(input = {}) {
    return this.serialized(async () => {
      this.assertOpen();
      const entry = this.previews.peek(ACCOUNT, input.previewId);
      let current;
      if (entry) {
        current = this.store.byName(entry.pack.name);
        const shown = entry.extra.replaces;
        if (current?.id !== shown?.id || current?.version !== shown?.version) {
          this.previews.discard(entry.previewId);
          throw problem(serverMessages.extensions.skillPreviewChanged, 409);
        }
        this.assertLocalName(entry.pack.name);
      }
      const preview = this.previews.take(ACCOUNT, input, {
        acceptedRules: current?.scan?.rules || [],
      });
      const { pack, scan } = preview;
      try {
        const skillFile = pack.files.find(([name]) => name === "SKILL.md")[1];
        const skill = this.store.write(pack, {
          importKind: preview.importKind,
          source: pack.source,
          origin: pack.origin,
          scan: {
            verdict: scan.verdict,
            rules: scan.rules,
            overridden: preview.overridden,
          },
          needsSettings: skillRequirements(skillFile).needsSettings,
        });
        return {
          skill,
          scan: {
            verdict: scan.verdict,
            rules: scan.rules,
            findings: scan.findings.length,
            importKind: preview.importKind,
            overridden: preview.overridden,
          },
          replaced: Boolean(current),
        };
      } catch (error) {
        this.previews.restore(preview);
        throw error;
      }
    });
  }
  /**
   * Downloads the GitHub source of catalog skill `id` again: the same content is up to
   * date, anything else comes back as a preview of the update.
   */
  async checkUpdate(id) {
    this.assertOpen();
    const record = this.store.byId(id);
    if (!record) throw problem(serverMessages.extensions.catalogSkillNotFound, 404);
    if (!record.source?.url)
      throw problem(serverMessages.extensions.catalogUpdateNeedsRepository, 400);
    const pack = await this.read({ url: record.source.url });
    this.assertOpen();
    // The same source now names another skill: an update never becomes a second skill.
    if (pack.name !== record.name)
      throw problem(serverMessages.extensions.catalogUpdateRenamed(pack.name), 409);
    if (contentHash(pack.files) === record.contentHash) return { upToDate: true };
    return this.previewPack(pack, "github");
  }
  async close() {
    this.closed = true;
    this.previews.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.keys(), this.queue]);
  }
}
