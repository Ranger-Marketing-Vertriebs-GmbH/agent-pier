import path from "node:path";
import os from "node:os";
import { LocalRpcBroker } from "../../lib/local-rpc-broker.js";
import { authorizeSsh } from "./ssh-capability.js";
import { SshCatalog } from "./ssh-catalog.js";
import { SshAccessStore } from "./ssh-access-store.js";
import { SshSessions } from "./ssh-sessions.js";
import { validateSshProjectBinding } from "./ssh-project-scope.js";
import { projectScope } from "../memory/project-scope.js";
import { readSshImport, sshImportPath } from "./ssh-import.js";
import { requestReceipt, replayReceipt, saveReceipt } from "./ssh-receipts.js";
import { publicSshError, sshProblem } from "./ssh-errors.js";
import { validateFields, publicKeyValue } from "./ssh-keys.js";
import { nameValue } from "../../lib/storage.js";
import {
  normalizedEndpoint,
  hostTuple,
  projectKey,
  trustedHost,
  trustedHostNow,
  moveProject,
} from "./ssh-management-records.js";

const allowed = {
  ssh_list_keys: ["page"],
  ssh_generate_key: ["name", "requestId"],
  ssh_import_key: ["name", "sourcePath", "requestId"],
  ssh_get_public_key: ["keyId"],
  ssh_scan_host: ["host", "port"],
  ssh_register_host: [
    "name",
    "host",
    "port",
    "username",
    "keyId",
    "hostKey",
    "trustSource",
    "requestId",
  ],
  ssh_test_host: ["accessId"],
};
const busy = () =>
  sshProblem("SSH_BUSY", "SSH management is busy; retry with the same request ID.", 429);

export class SshManagement {
  constructor({ dataDir, home = os.homedir(), barrier, audit, projectRegistry } = {}) {
    this.dataDir = path.resolve(dataDir);
    Object.assign(this, { home, barrier, audit, projectRegistry });
    this.catalog = new SshCatalog({ dataDir });
    this.store = new SshAccessStore({ dataDir, catalog: this.catalog });
    this.grants = new SshSessions({ dataDir, store: this.store });
    this.pending = new Set();
    this.preparing = new Set();
    this.broker = new LocalRpcBroker({
      root: this.catalog.root,
      name: "ssh",
      maxResponse: 524288,
      timeout: 31000,
      respond: (credential, request, signal) => this.respond(credential, request, signal),
    });
    this.ready = this.broker.ready.then(() => this.catalog.migrate());
  }
  async close() {
    this.closing = true;
    await this.ready.catch(() => {});
    await Promise.allSettled([...this.pending]);
    await this.catalog.queue.catch(() => {});
    await this.broker.close();
  }
  async respond(credential, request, signal) {
    const id = request?.id;
    if (
      !request ||
      request.jsonrpc !== "2.0" ||
      !["string", "number"].includes(typeof id) ||
      Object.keys(request).some(
        (key) => !["jsonrpc", "id", "method", "params", "generation"].includes(key),
      )
    )
      return {
        jsonrpc: "2.0",
        id: null,
        error: publicSshError(sshProblem("SSH_INVALID_ARGUMENT", "Invalid SSH request.")),
      };
    try {
      const result = await this.call(
        { ...credential, generation: request.generation },
        request.method,
        request.params,
        signal,
      );
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: publicSshError(error) };
    }
  }
  call(capability, name, input = {}, signal) {
    return this.track(() => this.perform(capability, name, input, signal));
  }
  track(callback) {
    if (this.closing || this.pending.size >= 32) return Promise.reject(busy());
    const operation = callback();
    this.pending.add(operation);
    return operation.finally(() => this.pending.delete(operation));
  }
  async context(capability, signal) {
    if (signal?.aborted || this.closing)
      throw sshProblem("SSH_UNAVAILABLE", "SSH request was interrupted.", 503);
    const session = authorizeSsh(this.dataDir, capability);
    const project = await validateSshProjectBinding(session.sshTools?.project);
    authorizeSsh(this.dataDir, capability);
    if (signal?.aborted || this.closing)
      throw sshProblem("SSH_UNAVAILABLE", "SSH request was interrupted.", 503);
    return { session, project };
  }
  rememberProject(project) {
    const record = {
      id: project.projectId ?? project.id,
      name: project.name,
      cwd: project.cwd,
      kind: project.kind,
    };
    const projects = this.catalog.read().projects;
    const previous = projects.find((row) => row.id === record.id);
    if (JSON.stringify(previous) !== JSON.stringify(record))
      this.catalog.replacePart("projects", [
        ...projects.filter((row) => row.id !== record.id),
        record,
      ]);
  }
  registerProject(binding) {
    return this.track(async () => {
      await this.ready;
      return this.mutation(async () =>
        this.rememberProject(await validateSshProjectBinding(binding)),
      );
    });
  }
  assertOpen() {
    if (this.closing)
      throw sshProblem("SSH_UNAVAILABLE", "SSH request was interrupted.", 503);
  }
  mutation(callback) {
    const run = () =>
      this.catalog.run(() => {
        this.assertOpen();
        this.catalog.beforeCommit(() => this.assertOpen());
        return callback();
      });
    return this.barrier ? this.barrier.run(run) : run();
  }
  emit(action, resourceId, context) {
    this.audit?.append({
      action,
      resourceType: "ssh",
      resourceId,
      source: context ? "mcp" : "user",
      outcome: "success",
      ...(context
        ? { sessionId: context.session.id, projectId: context.project.projectId }
        : {}),
    });
  }
  async perform(capability, name, input, externalSignal) {
    await this.ready;
    if (!Object.hasOwn(allowed, name))
      throw sshProblem("SSH_INVALID_ARGUMENT", "Unknown SSH management tool.");
    try {
      validateFields(input, allowed[name]);
    } catch {
      throw sshProblem("SSH_INVALID_ARGUMENT", "Invalid SSH tool arguments.");
    }
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const context = await this.context(capability, signal),
      projectId = context.project.projectId;
    if (name === "ssh_list_keys") {
      const page = input.page ?? 1;
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
        throw sshProblem("SSH_INVALID_ARGUMENT", "Invalid SSH key page.");
      const rows = this.store.keyStore
        .list()
        .filter((key) => key.projectId === projectId);
      return {
        items: rows.slice((page - 1) * 20, page * 20),
        page,
        pageSize: 20,
        total: rows.length,
      };
    }
    if (name === "ssh_get_public_key")
      return projectKey(this.store, input.keyId, projectId);
    if (name === "ssh_scan_host") {
      const result = await this.store.scan(normalizedEndpoint(input));
      await this.context(capability, signal);
      return { ...result, verified: false };
    }
    if (name === "ssh_test_host") {
      if (!(await this.grants.effective(context.session)).includes(input.accessId))
        throw sshProblem("SSH_WRONG_PROJECT", "SSH host is not assigned.", 403);
      const { SshTools } = await import("./ssh-tools.js");
      const tools = new SshTools({
        dataDir: this.dataDir,
        capability,
        grants: this.grants,
        store: this.store,
      });
      try {
        const result = await tools.call("ssh_execute", {
          accessId: input.accessId,
          command: "true",
          timeoutSeconds: 15,
        });
        await this.context(capability, signal);
        if (result.exitCode !== 0 || result.timedOut)
          throw sshProblem("SSH_OPERATION_FAILED", "SSH connection test failed.", 502);
        this.emit("ssh.tested", input.accessId, context);
        return { ok: true };
      } finally {
        await tools.close();
      }
    }
    const canonical = { ...input, name: nameValue(input.name) };
    if (name === "ssh_import_key")
      canonical.sourcePath = sshImportPath(
        input.sourcePath,
        context.session.sshTools.home || this.home,
      );
    if (name === "ssh_register_host") {
      Object.assign(canonical, normalizedEndpoint(input));
      canonical.hostKey = publicKeyValue(input.hostKey);
    }
    const receiptContext = {
      projectId,
      operation: name,
      requestId: input.requestId,
      input: canonical,
    };
    const resolve = (id) =>
      name === "ssh_register_host" ? this.store.get(id) : this.store.keyStore.get(id);
    const prior = requestReceipt(this.catalog, receiptContext);
    if (prior) return replayReceipt(prior, resolve);
    if (name === "ssh_register_host")
      return this.registerHost(capability, canonical, receiptContext, signal);
    if (this.preparing.has(capability.sessionId)) throw busy();
    this.preparing.add(capability.sessionId);
    let prepared;
    try {
      const privateKey =
        name === "ssh_import_key"
          ? readSshImport({
              sourcePath: canonical.sourcePath,
              home: this.home,
              dataDir: this.dataDir,
              identityPaths: this.catalog
                .read()
                .keys.flatMap((key) => [
                  path.join(this.catalog.root, "identities", key.id, "identity"),
                  ...(key.legacyHostIds || []).map((id) =>
                    path.join(this.catalog.root, "keys", id, "identity"),
                  ),
                ]),
            }).toString("utf8")
          : undefined;
      try {
        prepared = await this.store.keyStore.prepare({
          name: canonical.name,
          projectId,
          ...(privateKey === undefined ? {} : { privateKey }),
        });
      } catch (error) {
        if (error.status)
          throw sshProblem("SSH_KEY_UNSUPPORTED", "SSH key is invalid or encrypted.");
        throw error;
      }
      return await this.mutation(async () => {
        const current = await this.context(capability, signal);
        const previous = requestReceipt(this.catalog, receiptContext);
        if (previous) return replayReceipt(previous, resolve);
        this.rememberProject(current.project);
        const existing =
          name === "ssh_import_key" &&
          this.store.keyStore
            .list()
            .find(
              (key) =>
                key.projectId === projectId && key.publicKey === prepared.publicKey,
            );
        const key = existing || (await this.store.keyStore.publish(prepared));
        await this.context(capability, signal);
        saveReceipt(this.catalog, receiptContext, key);
        this.catalog.afterCommit(() => this.emit("ssh.created", key.id, current));
        return { ...key, reused: Boolean(existing) };
      });
    } finally {
      prepared?.cleanup();
      this.preparing.delete(capability.sessionId);
    }
  }
  async registerHost(capability, input, receiptContext, signal) {
    return this.mutation(async () => {
      const context = await this.context(capability, signal),
        projectId = context.project.projectId;
      const prior = requestReceipt(this.catalog, receiptContext);
      if (prior) return replayReceipt(prior, (id) => this.store.get(id));
      projectKey(this.store, input.keyId, projectId);
      await trustedHost(this.store, this.grants, context.session, input);
      const existing = this.store
        .list()
        .find(
          (row) => row.projectId === projectId && hostTuple(row) === hostTuple(input),
        );
      if (
        existing &&
        (existing.keyId !== input.keyId || existing.hostKey !== input.hostKey)
      )
        throw sshProblem(
          "SSH_HOST_CONFLICT",
          "The saved endpoint uses a different key or host pin. Change it in the UI.",
          409,
        );
      const { requestId: _request, trustSource: _trust, ...fields } = input;
      let host = existing || (await this.store.create({ ...fields, projectId }));
      if (!existing) {
        this.catalog.replacePart(
          "hosts",
          this.catalog
            .read()
            .hosts.map((row) =>
              row.id === host.id ? { ...row, trustSource: input.trustSource.kind } : row,
            ),
        );
        host = this.store.get(host.id);
      }
      await this.context(capability, signal);
      // A bootstrap grant may have been revoked during key fingerprint validation.
      await trustedHost(this.store, this.grants, context.session, input);
      await this.context(capability, signal);
      this.catalog.beforeCommit(() => {
        const session = authorizeSsh(this.dataDir, capability);
        if (signal?.aborted)
          throw sshProblem("SSH_UNAVAILABLE", "SSH request was interrupted.", 503);
        trustedHostNow(this.store, this.grants, session, input, projectId);
      });
      this.rememberProject(context.project);
      saveReceipt(this.catalog, receiptContext, host);
      this.catalog.afterCommit(() => this.emit("ssh.created", host.id, context));
      return host;
    });
  }
  async projects() {
    await this.ready;
    const known = this.projectRegistry?.projects().projects || [];
    return {
      projects: [
        ...new Map(
          [...known, ...this.catalog.read().projects].map((row) => [
            row.id,
            { id: row.id, name: row.name, cwd: row.cwd, kind: row.kind },
          ]),
        ).values(),
      ],
    };
  }
  async project(id) {
    if (id === undefined || id === null) return null;
    const project = (await this.projects()).projects.find((row) => row.id === id);
    if (!project)
      throw sshProblem("SSH_PROJECT_UNAVAILABLE", "SSH project is unavailable.", 404);
    let current;
    try {
      current = await projectScope(project.cwd);
    } catch {
      throw sshProblem(
        "SSH_PROJECT_UNAVAILABLE",
        "SSH project directory is unavailable.",
        409,
      );
    }
    if (current.id !== id)
      throw sshProblem("SSH_PROJECT_CHANGED", "SSH project identity changed.", 409);
    return project;
  }
  ui(action, input = {}) {
    return this.track(() => this.performUi(action, input));
  }
  async performUi(action, input) {
    await this.ready;
    if (this.closing) throw busy();
    if (action === "createKey") {
      const project = await this.project(input.projectId);
      const prepared = await this.store.keyStore.prepare({
        ...input,
        projectId: project?.id ?? null,
      });
      try {
        return await this.mutation(async () => {
          const current = await this.project(input.projectId);
          const key = await this.store.keyStore.publish(prepared);
          if (current) this.rememberProject(current);
          return key;
        });
      } finally {
        prepared.cleanup();
      }
    }
    return this.mutation(async () => {
      switch (action) {
        case "renameKey":
          return this.store.keyStore.rename(input.id, input.body);
        case "removeKey":
          return this.store.keyStore.remove(input.id);
        case "createHost": {
          const project = await this.project(input.projectId);
          if (project) this.rememberProject(project);
          return this.store.create(input);
        }
        case "updateHost":
          return this.store.update(input.id, input.body);
        case "removeHost":
          this.grants.revokeAccess(input.id);
          return this.store.remove(input.id);
        case "reassign": {
          const target = await this.project(input.toProjectId);
          if (!target)
            throw sshProblem("SSH_INVALID_ARGUMENT", "A target project is required.");
          return moveProject(this.catalog, input.fromProjectId, target);
        }
        default:
          throw sshProblem("SSH_INVALID_ARGUMENT", "Unknown SSH management action.");
      }
    });
  }
}
