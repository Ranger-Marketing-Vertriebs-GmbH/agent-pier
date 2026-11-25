import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";
import { readSkillPackTracked, skillRequirements } from "../extensions/skill-packages.js";
import { PREVIEW_TTL, SkillPreviews } from "../extensions/skill-previews.js";
import { contentHash, scanSkill } from "../extensions/skill-scan.js";

// Catalog previews belong to the owner; one fixed account id keeps them apart from
// the CLI profile previews of the same SkillPreviews code.
const ACCOUNT = "catalog";

// A checked source with several skills keeps their files until the owner chose; the
// newest two are kept (each holds at most 64 MiB, see unpackSkills).
const COLLECTION_LIMIT = 2;
const SELECTION_LIMIT = 200;

/** A refusal as a row shows it: the German text and its stable message key. */
const shown = (error) => ({
  message: error.message,
  ...messageIdentity(error.message),
});
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
 * A source with several skills is kept as a collection: the owner sees one row per
 * skill, installs the ones without open findings together (installFromCollection)
 * and reviews the others one by one (previewFromCollection). Writes run one after
 * another.
 */
export class SkillCatalog {
  constructor({
    store,
    bundledNames = () => new Set(),
    globalNames = () => new Set(),
    reportNames = async () => null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  }) {
    this.store = store;
    this.bundledNames = bundledNames;
    this.globalNames = globalNames;
    this.reportNames = reportNames;
    this.fetchImpl = fetchImpl;
    this.previews = new SkillPreviews();
    this.collections = new Map();
    this.now = now;
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
    return readSkillPackTracked(this.active, input, this.fetchImpl, { several: true });
  }
  /**
   * What installing a scanned pack would do now: `state` "new", "update", "current"
   * (the catalog already has exactly this content), "bundled" or "taken" (the name
   * belongs to another source); `review` when its findings need the owner's decision.
   */
  rowOf(pack, scan, hash, reported) {
    const refused = this.bundledNames().has(pack.name)
      ? "bundled"
      : this.globalNames().has(pack.name) || reported?.has(pack.name)
        ? "taken"
        : null;
    const previous = this.store.byName(pack.name);
    const accepted = new Set(previous?.scan?.rules || []);
    const newRules = scan.rules.filter((rule) => !accepted.has(rule));
    return {
      state:
        refused ||
        (!previous ? "new" : previous.contentHash === hash ? "current" : "update"),
      ...(previous ? { replaces: { id: previous.id, version: previous.version } } : {}),
      newRules,
      review:
        scan.verdict === "block" ||
        (scan.verdict === "warn" && (!previous || newRules.length > 0)),
    };
  }
  /** Scans every skill of a source and keeps the installable ones for the choice. */
  async keepCollection(read, importKind) {
    const reported = await this.reportNames();
    this.assertOpen();
    const names = new Set();
    const items = new Map();
    const skills = read.collection.map(({ folder, pack, error }) => {
      if (error) return { folder, state: "invalid", problem: shown(error) };
      const scan = scanSkill(pack.files);
      const hash = contentHash(pack.files);
      // Two folders naming one skill: the first is offered, the others are not.
      const duplicate = names.has(pack.name);
      names.add(pack.name);
      if (!duplicate) items.set(folder, { pack, scan, hash });
      return {
        folder,
        name: pack.name,
        description: pack.description,
        contentHash: hash,
        size: pack.files.reduce((sum, [, data]) => sum + data.length, 0),
        files: pack.files.length,
        verdict: scan.verdict,
        rules: scan.rules,
        findings: scan.findings.length,
        ...this.rowOf(pack, scan, hash, reported),
        ...(duplicate ? { state: "duplicate" } : {}),
      };
    });
    const now = this.now();
    for (const [id, entry] of this.collections)
      if (entry.expires < now) this.collections.delete(id);
    while (this.collections.size >= COLLECTION_LIMIT)
      this.collections.delete(this.collections.keys().next().value);
    const collectionId = randomUUID();
    const expires = now + PREVIEW_TTL;
    this.collections.set(collectionId, { items, importKind, expires });
    return {
      collectionId,
      expiresAt: new Date(expires).toISOString(),
      importKind,
      ...(read.origin ? { origin: read.origin } : {}),
      skills,
    };
  }
  /** The kept skill `folder` of a live collection and the collection's import kind. */
  collected(collectionId, folder) {
    const entry =
      typeof collectionId === "string" ? this.collections.get(collectionId) : undefined;
    if (!entry || entry.expires < this.now()) {
      this.collections.delete(collectionId);
      throw problem(serverMessages.extensions.skillPreviewExpired, 409);
    }
    const item = typeof folder === "string" ? entry.items.get(folder) : undefined;
    if (!item) throw problem(serverMessages.extensions.skillPreviewChanged, 409);
    return { ...item, importKind: entry.importKind };
  }
  /** The full preview of one skill of a collection, confirmed through install. */
  async previewFromCollection(collectionId, input = {}) {
    this.assertOpen();
    const { pack, importKind } = this.collected(collectionId, input.folder);
    return this.previewPack(pack, importKind);
  }
  /**
   * Installs the chosen skills of a collection (`input.skills`: `{ folder,
   * contentHash }`) exactly as scanned. Only skills without an open decision install
   * here; one with new warnings or a block is skipped and goes through its own
   * preview. Returns `installed` (as install() returns, with `folder`) and `skipped`
   * (`{ folder, problem }`); one refused skill never stops the others.
   */
  installFromCollection(collectionId, input = {}) {
    return this.serialized(async () => {
      this.assertOpen();
      const wanted = Array.isArray(input.skills)
        ? input.skills.slice(0, SELECTION_LIMIT)
        : [];
      const installed = [];
      const skipped = [];
      const reported = wanted.length ? await this.reportNames() : null;
      this.assertOpen();
      for (const want of wanted) {
        const folder = want?.folder;
        try {
          const item = this.collected(collectionId, folder);
          if (want.contentHash !== item.hash)
            throw problem(serverMessages.extensions.skillPreviewChanged, 409);
          // The name is checked again, as the listing checked it.
          const row = this.rowOf(item.pack, item.scan, item.hash, reported);
          if (row.state === "bundled")
            throw problem(serverMessages.extensions.catalogNameBundled, 409);
          if (row.state === "taken")
            throw problem(serverMessages.extensions.catalogNameTaken, 409);
          if (row.state === "current") continue;
          if (item.scan.verdict === "block")
            throw problem(serverMessages.extensions.skillScanBlocked, 409);
          if (row.review)
            throw problem(serverMessages.extensions.skillWarningsNotAccepted, 409);
          installed.push({
            folder,
            ...this.writeScanned(item.pack, item.scan, item.importKind, {
              replaced: Boolean(row.replaces),
            }),
          });
        } catch (error) {
          if (!error.status)
            console.error(
              `AgentPier could not install a catalog skill (${error?.code || error?.message || "no code"}).`,
            );
          skipped.push({
            folder: typeof folder === "string" ? folder : "",
            problem: shown(
              error.status ? error : problem(serverMessages.extensions.skillSaveFailed),
            ),
          });
        }
      }
      return { installed, skipped };
    });
  }
  /** Writes a scanned pack into the catalog: what install() returns for it. */
  writeScanned(pack, scan, importKind, { overridden = false, replaced = false } = {}) {
    const skillFile = pack.files.find(([name]) => name === "SKILL.md")[1];
    const skill = this.store.write(pack, {
      importKind,
      source: pack.source,
      origin: pack.origin,
      scan: { verdict: scan.verdict, rules: scan.rules, overridden },
      needsSettings: skillRequirements(skillFile).needsSettings,
    });
    return {
      skill,
      scan: {
        verdict: scan.verdict,
        rules: scan.rules,
        findings: scan.findings.length,
        importKind,
        overridden,
      },
      replaced,
    };
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
  /**
   * Reads and scans a source (nothing is written); confirmed through install. With
   * `skillId` (a new version of that catalog skill) a source naming another skill is
   * refused, so an update never becomes a second skill.
   */
  async preview(input = {}) {
    this.assertOpen();
    const expected = input.skillId === undefined ? null : this.store.byId(input.skillId);
    if (input.skillId !== undefined && !expected)
      throw problem(serverMessages.extensions.catalogSkillNotFound, 404);
    const pack = await this.read(input);
    this.assertOpen();
    if (pack.collection) {
      if (expected)
        throw problem(serverMessages.extensions.skillCollectionSingleRequired, 409);
      return { collection: await this.keepCollection(pack, importKindOf(input)) };
    }
    if (expected && pack.name !== expected.name)
      throw problem(
        serverMessages.extensions.catalogUploadOtherSkill(pack.name, expected.name),
        409,
      );
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
        return this.writeScanned(pack, scan, preview.importKind, {
          overridden: preview.overridden,
          replaced: Boolean(current),
        });
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
    if (pack.collection)
      throw problem(serverMessages.extensions.skillCollectionSingleRequired, 409);
    // The same source now names another skill: an update never becomes a second skill.
    if (pack.name !== record.name)
      throw problem(serverMessages.extensions.catalogUpdateRenamed(pack.name), 409);
    if (contentHash(pack.files) === record.contentHash) return { upToDate: true };
    return this.previewPack(pack, "github");
  }
  /**
   * Downloads GitHub repository `repository` at `ref` once and compares every catalog
   * skill installed from it. `{ upToDate: true }` when none changed; otherwise the
   * source as a collection (see keepCollection) with `updates`, the ids of the catalog
   * skills it would replace, so their updates install together. `checked` counts the
   * catalog skills compared, `more` the skills of the source the catalog does not have.
   */
  async checkSource({ repository, ref } = {}) {
    this.assertOpen();
    const records = this.store
      .list()
      .filter(
        (record) =>
          record.source?.url &&
          record.origin?.kind === "github" &&
          record.origin.repository === repository &&
          record.origin.ref === ref,
      );
    if (!records.length)
      throw problem(serverMessages.extensions.catalogSkillNotFound, 404);
    const read = await this.read({
      url: `https://github.com/${repository}/tree/${encodeURIComponent(ref)}`,
    });
    this.assertOpen();
    // The repository holds one skill by now: it is the update of the skill of that name.
    const collection = read.collection
      ? read
      : { collection: [{ folder: read.name, pack: read }], origin: read.origin };
    const listed = await this.keepCollection(collection, "github");
    const ids = new Set(records.map((record) => record.id));
    const updates = listed.skills
      .filter((skill) => skill.state === "update" && ids.has(skill.replaces?.id))
      .map((skill) => skill.replaces.id);
    const counts = {
      checked: records.length,
      more: listed.skills.filter((skill) => skill.state === "new").length,
    };
    if (!updates.length) {
      this.collections.delete(listed.collectionId);
      return { upToDate: true, ...counts };
    }
    return { upToDate: false, ...counts, updates, collection: listed };
  }
  /**
   * Removes catalog skill `id` after every earlier write; 404 when it is unknown.
   * `switchOff(name)` (async, returns the changed agent ids) runs in the same turn of
   * the write queue before and again after the record goes, so a switch-on saved while
   * the removal waited never leaves the name behind; after the removal no agent can
   * switch it on again. Returns the record and every agent switched off.
   */
  remove(id, switchOff = async () => []) {
    return this.serialized(async () => {
      this.assertOpen();
      const known = this.store.byId(id);
      if (!known) throw problem(serverMessages.extensions.skillNotInstalledHere, 404);
      const before = await switchOff(known.name);
      const record = this.store.remove(id);
      const after = await switchOff(record.name);
      return { record, switchedOff: [...new Set([...before, ...after])] };
    });
  }
  async close() {
    this.closed = true;
    this.previews.clear();
    this.collections.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.keys(), this.queue]);
  }
}
