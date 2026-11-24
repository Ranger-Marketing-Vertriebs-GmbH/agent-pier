import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { DirectoryWatchers } from "../../lib/directory-watchers.js";
import { projectId, projectScope } from "../memory/project-scope.js";
import {
  orderDirectory,
  orderFilename,
  readOrderFile,
  removeOrderFile,
  withOrderLock,
  writeOrderFile,
} from "../cli-profiles/skills/agentpier-composer/scripts/order-progress.mjs";
import { orderError } from "./order-error.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const fileKey = (projectId, filename) => hash([projectId, filename]);
const knownOrderKeys = [
  "id",
  "title",
  "brief",
  "task",
  "scope",
  "topic",
  "topics",
  "epic",
  "repo",
  "repository",
  "baseBranch",
  "batches",
  "draftBatches",
  "items",
  "tickets",
  "runs",
  "checkpoint",
  "status",
  "projectId",
  "worktree",
  "nextAction",
];
const protectedReference = new Set([
  "id",
  "projectId",
  "projectRoot",
  "commonDir",
  "filename",
  "managed",
  "requestId",
  "receipt",
  "initial",
]);
function reference(state, id) {
  const ref = Object.hasOwn(state.refs, id) && state.refs[id];
  if (!ref) throw orderError("orderNotFound", 404);
  return ref;
}
function result(ref, document = null, limitations = []) {
  return {
    ref,
    document,
    limitations: [
      ...limitations,
      ...(!ref.managed ? ["unmanaged"] : []),
      ...(document && !document.id ? ["missingId"] : []),
    ],
  };
}
// Memory has already registered this project. Recompute its identity from the
// actual checkout, even for a saved reference; a folder may have been replaced.
async function resolveProject(project) {
  if (!project || (project.kind && project.kind !== "git")) return null;
  try {
    const scope = await projectScope(project.cwd);
    if (scope.kind !== "git" || scope.id !== project.id) return null;
    const [, commonDir] = JSON.parse(scope.identity);
    return { projectId: project.id, projectRoot: scope.cwd, commonDir };
  } catch {
    return null;
  }
}

export class OrderStore {
  constructor({ dataDir, projects, onChange = () => {} }) {
    this.file = path.join(dataDir, "autopilot", "register.json");
    this.projects = projects;
    this.onChange = onChange;
    this.watchers = new DirectoryWatchers({ maxDirectories: Infinity });
    this.watches = new Map();
    this.closed = false;
  }

  #state() {
    return readJSON(this.file, { version: 1, refs: {}, removed: {} });
  }
  #save(state) {
    writePrivate(this.file, state);
  }

  // The pipeline capability checks these synchronously at admission, including
  // queue promotion. Repository files can never bind or retire a session.
  byId(id) {
    const { refs } = this.#state();
    return Object.hasOwn(refs, id) ? refs[id] : null;
  }

  sessionOrder(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return (
      Object.values(this.#state().refs).find(
        (ref) =>
          ref.managed &&
          (ref.resources?.sessionId === sessionId ||
            ref.resources?.retiredSessionIds?.includes(sessionId)),
      ) ?? null
    );
  }

  assertStart(sessionId, grantProjectId) {
    const ref = this.sessionOrder(sessionId);
    if (!ref) return;
    if (
      !ref.cleanup &&
      ref.resources.sessionId === sessionId &&
      !ref.resources.retiredSessionIds?.includes(sessionId) &&
      ref.projectId === grantProjectId
    ) {
      try {
        const stat = fs.lstatSync(ref.commonDir, { bigint: true });
        if (
          stat.isDirectory() &&
          projectId(["git", ref.commonDir, String(stat.dev), String(stat.ino)]) ===
            ref.projectId
        ) {
          const doc = readOrderFile(orderDirectory(ref.commonDir), ref.filename);
          if (
            doc.id === ref.id &&
            doc.projectId === ref.projectId &&
            doc.implementationAuthorized === true &&
            doc.manualPaused === false &&
            typeof doc.status === "string" &&
            doc.status !== "completed"
          )
            return;
        }
      } catch {
        // Missing, replaced and unreadable orders all withhold execution.
      }
    }
    throw orderError("executionUnavailable", 403);
  }

  async #project(id) {
    return resolveProject((await this.projects()).find((p) => p.id === id));
  }
  #currentProject(project, ref) {
    return project?.projectId === ref.projectId && project.commonDir === ref.commonDir;
  }
  #requiredProject(project, ref) {
    if (!this.#currentProject(project, ref)) throw orderError("projectUnavailable");
  }
  // Watch the parent even before the first Composer file exists. Its events
  // also rebind the child watcher when a directory is removed and recreated.
  #watch(project) {
    if (this.closed) return;
    const { projectId, commonDir } = project;
    const watch = (dir, child, names, callback) => {
      const key = projectId + ":" + child;
      const old = this.watches.get(key);
      let identity;
      try {
        const stat = fs.lstatSync(dir, { bigint: true });
        if (stat.isDirectory()) identity = `${stat.dev}:${stat.ino}`;
      } catch {}
      if (
        identity &&
        old?.dir === dir &&
        old.identity === identity &&
        old.release.alive()
      )
        return;
      old?.release();
      this.watches.delete(key);
      if (!identity) return;
      const release = this.watchers.add(dir, names, callback, identity);
      if (release) this.watches.set(key, { dir, identity, release, projectId });
    };
    watch(commonDir, "parent", "agentpier-composer", () => {
      this.#watch(project);
      this.onChange(projectId, null);
    });
    watch(path.join(commonDir, "agentpier-composer"), "orders", null, (name) => {
      if (name && !orderFilename(name)) return;
      const ref =
        name &&
        Object.values(this.#state().refs).find(
          (r) => r.projectId === projectId && r.filename === name,
        );
      this.onChange(projectId, ref?.id ?? null);
    });
  }

  #read(ref, project) {
    if (!this.#currentProject(project, ref))
      return result(ref, null, ["projectUnavailable"]);
    let document;
    try {
      document = readOrderFile(orderDirectory(ref.commonDir), ref.filename);
    } catch (e) {
      return result(ref, null, [e.code === "ENOENT" ? "missingFile" : "unreadableFile"]);
    }
    if (ref.managed && document.id !== ref.id)
      return result(ref, null, ["identityMismatch"]);
    return result(ref, document);
  }

  async list() {
    const projects = (
      await Promise.all((await this.projects()).map(resolveProject))
    ).filter(Boolean);
    const byProject = new Map(projects.map((p) => [p.projectId, p]));
    for (const [key, watch] of this.watches) {
      if (!byProject.has(watch.projectId)) {
        watch.release();
        this.watches.delete(key);
      }
    }
    const state = this.#state();
    const registered = new Set(
      Object.values(state.refs).map((r) => fileKey(r.projectId, r.filename)),
    );
    let changed = false;
    for (const project of byProject.values()) {
      this.#watch(project);
      let folder, entries;
      try {
        folder = orderDirectory(project.commonDir);
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const filename = entry.name;
        if (!entry.isFile() || !orderFilename(filename)) continue;
        const key = fileKey(project.projectId, filename);
        if (registered.has(key) || Object.hasOwn(state.removed, key)) continue;
        try {
          const doc = readOrderFile(folder, filename);
          if (!knownOrderKeys.some((k) => Object.hasOwn(doc, k))) continue;
        } catch {
          continue;
        }
        const id = "local-" + key;
        state.refs[id] = { id, ...project, filename, managed: false };
        registered.add(key);
        changed = true;
      }
    }
    if (changed) this.#save(state);
    return Object.values(state.refs).map((ref) =>
      this.#read(ref, byProject.get(ref.projectId)),
    );
  }

  async get(id) {
    const ref = reference(this.#state(), id);
    const project = await this.#project(ref.projectId);
    const current = reference(this.#state(), id);
    if (this.#currentProject(project, current)) this.#watch(project);
    return this.#read(current, project);
  }

  async create(projectId, initial, { selection, baseBranch } = {}) {
    const project = await this.#project(projectId);
    if (!project) throw orderError("projectUnavailable");
    if (
      typeof initial.requestId !== "string" ||
      !initial.requestId.trim() ||
      initial.requestId.length > 200
    )
      throw orderError("invalidOrder", 400);
    this.#watch(project);
    // No await between register mutations. Publish the reservation before the
    // order. A restart can replay precisely this initial publication.
    return withOrderLock(() => {
      const state = this.#state();
      const { requestId, ...fields } = initial;
      if (
        Object.values(state.removed).some(
          (r) => r.projectId === projectId && r.requestId === requestId,
        )
      )
        throw orderError("requestRemoved", 410);
      const receipt = hash(canonical([initial, selection, baseBranch]));
      let ref = Object.values(state.refs).find(
        (r) => r.projectId === projectId && r.requestId === requestId,
      );
      if (ref && ref.receipt !== receipt) throw orderError("requestConflict");
      if (!ref) {
        const id = randomUUID();
        const document = {
          status: "draft",
          draftBatches: [],
          batches: [],
          implementationAuthorized: false,
          ...fields,
          ...(baseBranch ? { baseBranch } : {}),
          schemaVersion: 1,
          id,
          projectId,
          allowMerge: initial.allowMerge === true,
          manualPaused: false,
        };
        ref = {
          id,
          ...project,
          filename: id + ".json",
          managed: true,
          requestId,
          receipt,
          selection,
          baseBranch,
          initial: document,
        };
        state.refs[id] = ref;
        this.#save(state);
      }
      this.#requiredProject(project, ref);
      if (ref.initial) {
        try {
          const folder = orderDirectory(ref.commonDir, true);
          let existing;
          try {
            existing = readOrderFile(folder, ref.filename);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (existing && !isDeepStrictEqual(existing, ref.initial))
            throw orderError("unsafeOrderFile");
          if (!existing)
            writeOrderFile(folder, ref.filename, ref.initial, { exclusive: true });
        } catch {
          throw orderError("unsafeOrderFile");
        }
        delete ref.initial;
        this.#save(state);
        this.onChange(projectId, ref.id);
      }
      return this.#read(ref, project);
    });
  }

  async update(id, transform) {
    const saved = reference(this.#state(), id);
    const project = await this.#project(saved.projectId);
    return withOrderLock(() => {
      const ref = reference(this.#state(), id);
      this.#requiredProject(project, ref);
      const { document } = this.#read(ref, project);
      if (!document) throw orderError("orderFileUnavailable");
      const oldId = document.id;
      const updated = transform(document);
      if (!updated || updated.id !== oldId) throw orderError("invalidOrder", 400);
      try {
        writeOrderFile(orderDirectory(ref.commonDir), ref.filename, updated);
      } catch {
        throw orderError("unsafeOrderFile");
      }
      this.onChange(ref.projectId, id);
      return result(ref, updated);
    });
  }

  async setReference(id, metadata) {
    const state = this.#state();
    const ref = reference(state, id);
    if (Object.keys(metadata).some((k) => protectedReference.has(k)))
      throw orderError("invalidOrder", 400);
    Object.assign(ref, metadata);
    this.#save(state);
    this.onChange(ref.projectId, id);
    return this.get(id);
  }

  // Called only after the lifecycle service has journaled and validated each
  // owned resource. A retry may arrive after unlink and before the last save.
  async remove(id) {
    const saved = reference(this.#state(), id);
    const project = await this.#project(saved.projectId);
    return withOrderLock(() => {
      const state = this.#state();
      const ref = reference(state, id);
      this.#requiredProject(project, ref);
      if (!ref.managed || !ref.cleanup || ref.filename !== id + ".json")
        throw orderError("cleanupUnavailable");
      try {
        const folder = orderDirectory(ref.commonDir);
        removeOrderFile(folder, ref.filename, id);
      } catch (e) {
        if (e.code !== "ENOENT") throw orderError("unsafeOrderFile");
      }
      state.removed[fileKey(ref.projectId, ref.filename)] = {
        projectId: ref.projectId,
        requestId: ref.requestId,
      };
      delete state.refs[id];
      this.#save(state);
      this.onChange(ref.projectId, id);
    });
  }

  close() {
    this.closed = true;
    for (const watch of this.watches.values()) watch.release();
    this.watches.clear();
    this.watchers.close();
  }
}
