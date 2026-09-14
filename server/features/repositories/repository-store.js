import { commitIdentity as identityValue } from "./commit-identity.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { shellQuote } from "../../lib/launch-serialization.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  discoverAccessibleRepositories,
  validRepositoryComponent,
} from "./repository-discovery.js";
import {
  privateDirectory,
  writePrivate,
  readJSON,
  problem,
  nameValue,
} from "../../lib/storage.js";

function httpsOrigin(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\s\\?#]/.test(value) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw problem(serverMessages.repositories.validHttpsHostRequired);
  const source = value.includes("://") ? value : `https://${value}`;
  if (!/^https:\/\/[^/]+\/?$/i.test(source))
    throw problem(serverMessages.repositories.httpsHostRequired);
  let url;
  try {
    url = new URL(source);
  } catch {
    throw problem(serverMessages.repositories.invalidHttpsHost);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    throw problem(serverMessages.repositories.invalidHttpsHost);
  return url.origin;
}
function tokenValue(value, optional = false) {
  if (value === undefined && optional) return null;
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value))
    throw problem(serverMessages.repositories.invalidAccessToken);
  const token = value.trim();
  if (!token && !optional) throw problem(serverMessages.repositories.accessTokenRequired);
  return token || null;
}
function repositoryURL(value, origin) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\s\\\x00-\x1f\x7f]/.test(value)
  )
    throw problem(serverMessages.repositories.repositoryAddressRequired);
  if (
    /^[\w.-]+\/[\w.-]+$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  )
    value = `${origin}/${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(serverMessages.repositories.invalidRepositoryUrl);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(value) ||
    url.pathname === "/" ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)
  )
    throw problem(serverMessages.repositories.repositoryHostMismatch);
  return url.href;
}

function cloneEnvironment(scratch) {
  const env = { ...process.env };
  // Preserve proxy and custom certificate support, but discard every inherited
  // Git override (config injection, helpers, tracing, executable paths, etc.).
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") && !["GIT_SSL_CAINFO", "GIT_SSL_CAPATH"].includes(key))
      delete env[key];
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return {
    ...env,
    HOME: scratch,
    XDG_CONFIG_HOME: scratch,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GCM_INTERACTIVE: "Never",
    AGENTPIER_GIT_CREDENTIAL_FILE: path.join(scratch, "credential.json"),
  };
}
function runClone(args, options, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(problem(serverMessages.repositories.cloneShutdown, 503));
    let stderr = "";
    let timedOut = false;
    const child = spawn("git", args, {
      ...options,
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    const stop = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const release = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 32768)
        stderr += chunk.toString().slice(0, 32768 - stderr.length);
    });
    child.once("error", () => {
      release();
      reject(problem(serverMessages.repositories.gitUnavailable));
    });
    child.once("close", (code) => {
      release();
      if (signal.aborted)
        return reject(problem(serverMessages.repositories.cloneShutdown, 503));
      if (timedOut) return reject(problem(serverMessages.repositories.cloneTimeout, 504));
      if (code === 0) return resolve();
      // Never surface raw Git output: servers can echo credentials in any error.
      let message = serverMessages.repositories.cloneFailed;
      if (
        /authentication failed|could not read Username|access denied|403|401/i.test(
          stderr,
        )
      )
        message = serverMessages.repositories.cloneAuthenticationFailed;
      else if (/certificate|SSL peer|SSL connect/i.test(stderr))
        message = serverMessages.repositories.cloneCertificateFailed;
      else if (/redirect/i.test(stderr))
        message = serverMessages.repositories.cloneRedirectUnsupported;
      reject(problem(message));
    });
  });
}

export class RepositoryStore {
  constructor({
    dataDir,
    home = os.homedir(),
    cloneTimeoutMs = 120000,
    fetchImpl = globalThis.fetch,
  }) {
    this.dataDir = privateDirectory(path.resolve(dataDir));
    this.home = home;
    this.cloneTimeoutMs = Number.isFinite(cloneTimeoutMs)
      ? Math.max(100, Math.min(300000, cloneTimeoutMs))
      : 120000;
    this.closed = false;
    this.activeClones = new Map();
    this.discoveryCache = new Map();
    this.activeDiscoveries = new Map();
    this.fetchImpl = fetchImpl;
    this.file = path.join(this.dataDir, "repositories.json");
    this.secretDir = privateDirectory(path.join(this.dataDir, "repository-secrets"));
    const saved = readJSON(this.file, { credentials: [], projects: [] });
    this.credentials = saved.credentials;
    this.projects = saved.projects;
  }
  save() {
    writePrivate(this.file, {
      credentials: this.credentials,
      projects: this.projects,
    });
  }
  listCredentials() {
    return this.credentials.map((item) => ({
      ...item,
      agentDefault: this.defaultForHost(item.host)?.id === item.id,
    }));
  }
  defaultForHost(host) {
    const entries = this.credentials.filter((item) => item.host === host);
    return entries.find((item) => item.agentDefault === true) || entries[0];
  }
  materializeDefaults() {
    const ids = new Set(
      this.listCredentials()
        .filter((item) => item.agentDefault)
        .map((item) => item.id),
    );
    for (const item of this.credentials) item.agentDefault = ids.has(item.id);
  }
  setAgentDefault(item, value) {
    if (value === true) {
      for (const entry of this.credentials)
        if (entry.host === item.host) entry.agentDefault = false;
    } else if (item.agentDefault) {
      const other = this.credentials.find(
        (entry) => entry.host === item.host && entry.id !== item.id,
      );
      if (other) other.agentDefault = true;
    }
    item.agentDefault = value;
    this.materializeDefaults();
  }
  listProjects() {
    return this.projects.map((item) => ({ ...item }));
  }
  credential(id) {
    const item = this.credentials.find((item) => item.id === id);
    if (!item) throw problem(serverMessages.repositories.profileNotFound, 404);
    return item;
  }
  secretFile(id) {
    return path.join(this.secretDir, `${id}.json`);
  }
  createCredential({ name, host, token, agentDefault, commitIdentity } = {}) {
    const identity = identityValue(commitIdentity);
    name = nameValue(name);
    host = httpsOrigin(host);
    token = tokenValue(token);
    if (agentDefault !== undefined && typeof agentDefault !== "boolean")
      throw problem(serverMessages.repositories.invalidDefaultAgent);
    this.materializeDefaults();
    const selected = agentDefault ?? !this.credentials.some((item) => item.host === host);
    const item = {
      id: randomUUID(),
      name,
      host,
      hasSecret: true,
      createdAt: new Date().toISOString(),
      ...(identity ? { commitIdentity: identity } : {}),
    };
    writePrivate(this.secretFile(item.id), { token });
    this.credentials.push(item);
    this.setAgentDefault(item, selected);
    this.save();
    return { ...item };
  }
  updateCredential(id, { name, host, token, agentDefault, commitIdentity } = {}) {
    const identity =
      commitIdentity === undefined ? undefined : identityValue(commitIdentity);
    const item = this.credential(id);
    if (agentDefault !== undefined && typeof agentDefault !== "boolean")
      throw problem(serverMessages.repositories.invalidDefaultAgent);
    this.discoveryCache.delete(id);
    name = nameValue(name);
    host = host === undefined ? item.host : httpsOrigin(host);
    token = tokenValue(token, true);
    this.materializeDefaults();
    const selected =
      agentDefault ??
      (host === item.host
        ? item.agentDefault
        : !this.credentials.some((entry) => entry.id !== id && entry.host === host));
    if (token) writePrivate(this.secretFile(item.id), { token });
    Object.assign(item, { name, host });
    if (identity) item.commitIdentity = identity;
    else if (identity === null) delete item.commitIdentity;
    this.setAgentDefault(item, selected);
    this.save();
    return { ...item };
  }
  removeCredential(id) {
    const item = this.credential(id);
    this.discoveryCache.delete(id);
    fs.rmSync(this.secretFile(item.id), { force: true });
    this.credentials = this.credentials.filter((entry) => entry.id !== item.id);
    this.materializeDefaults();
    this.save();
  }
  async discover({ credentialId, query = "", organization = "", page = "1" } = {}) {
    if (this.closed) throw problem(serverMessages.common.serverStopping, 503);
    const credential = this.credential(credentialId);
    if (typeof query !== "string" || query.length > 200 || /[\x00-\x1f\x7f]/.test(query))
      throw problem(serverMessages.repositories.invalidSearchText);
    if (organization !== "" && !validRepositoryComponent(organization))
      throw problem(serverMessages.repositories.invalidOrganization);
    if (!/^[1-9][0-9]?$/.test(String(page)) || Number(page) > 20)
      throw problem(serverMessages.repositories.invalidPage);
    page = Number(page);
    let cached = this.discoveryCache.get(credential.id);
    if (!cached || cached.expires <= Date.now()) {
      const secret = readJSON(this.secretFile(credential.id), null);
      if (!secret?.token) throw problem(serverMessages.repositories.profileTokenMissing);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const pending = discoverAccessibleRepositories({
        host: credential.host,
        token: secret.token,
        fetchImpl: this.fetchImpl,
        signal,
      });
      cached = { pending, expires: Date.now() + 60000 };
      this.discoveryCache.set(credential.id, cached);
      this.activeDiscoveries.set(pending, controller);
      pending.then(
        () => this.activeDiscoveries.delete(pending),
        () => {
          this.activeDiscoveries.delete(pending);
          if (this.discoveryCache.get(credential.id)?.pending === pending)
            this.discoveryCache.delete(credential.id);
        },
      );
    }
    const data = await cached.pending;
    const search = query.trim().toLowerCase();
    const matches = data.repositories.filter(
      (item) =>
        (!organization || item.owner.toLowerCase() === organization.toLowerCase()) &&
        item.fullName.toLowerCase().includes(search),
    );
    const start = (page - 1) * 50;
    return {
      organizations: data.organizations,
      repositories: matches.slice(start, start + 50),
      total: matches.length,
      page,
      hasMore: start + 50 < matches.length,
      truncated: data.truncated,
    };
  }
  clone(options = {}) {
    if (this.closed)
      return Promise.reject(
        problem(serverMessages.repositories.cloneServiceStopping, 503),
      );
    const controller = new AbortController();
    const pending = this.cloneRepository(options, controller.signal);
    this.activeClones.set(pending, controller);
    pending.then(
      () => this.activeClones.delete(pending),
      () => this.activeClones.delete(pending),
    );
    return pending;
  }
  async close() {
    this.closed = true;
    const pending = [...this.activeClones.keys(), ...this.activeDiscoveries.keys()];
    for (const controller of this.activeDiscoveries.values()) controller.abort();
    this.discoveryCache.clear();
    for (const controller of this.activeClones.values()) controller.abort();
    // These promises settle only after each clone's catch/finally cleanup.
    await Promise.allSettled(pending);
  }
  async cloneRepository({ credentialId, url, parentDirectory, folderName }, signal) {
    const credential =
      credentialId === undefined || credentialId === null || credentialId === ""
        ? null
        : this.credential(credentialId);
    url = repositoryURL(url, credential?.host || "https://github.com");
    if (
      typeof folderName !== "string" ||
      !folderName.trim() ||
      folderName.length > 200 ||
      folderName === "." ||
      folderName === ".." ||
      /[/\\\x00-\x1f\x7f]/.test(folderName)
    )
      throw problem(serverMessages.repositories.newFolderNameRequired);
    if (
      typeof parentDirectory !== "string" ||
      !parentDirectory.trim() ||
      /[\x00-\x1f\x7f]/.test(parentDirectory)
    )
      throw problem(serverMessages.repositories.targetFolderRequired);
    let parent;
    try {
      const expanded =
        parentDirectory === "~"
          ? this.home
          : parentDirectory.startsWith("~/")
            ? path.join(this.home, parentDirectory.slice(2))
            : parentDirectory;
      parent = fs.realpathSync(path.resolve(expanded));
      if (!fs.statSync(parent).isDirectory()) throw new Error();
    } catch {
      throw problem(serverMessages.repositories.targetParentUnavailable);
    }
    const destination = path.join(parent, folderName);
    let identity;
    let scratch;
    try {
      try {
        fs.mkdirSync(destination, { mode: 0o700 });
      } catch (error) {
        if (error.code === "EEXIST")
          throw problem(serverMessages.repositories.targetAlreadyExists, 409);
        throw problem(serverMessages.repositories.targetCreateFailed);
      }
      identity = fs.lstatSync(destination);
      scratch = fs.mkdtempSync(path.join(this.dataDir, ".clone-"));
      fs.chmodSync(scratch, 0o700);
      if (credential) {
        const secret = readJSON(this.secretFile(credential.id), null);
        if (!secret?.token)
          throw problem(serverMessages.repositories.profileTokenMissing);
        writePrivate(path.join(scratch, "credential.json"), {
          host: credential.host,
          token: secret.token,
        });
      }
      const helper = `!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("../../git-credential.mjs", import.meta.url)))}`;
      const configs = [
        "credential.helper=",
        ...(credential ? [`credential.helper=${helper}`] : []),
        "credential.useHttpPath=false",
        "credential.interactive=false",
        "core.hooksPath=/dev/null",
        "core.askPass=",
        "init.templateDir=",
        "http.followRedirects=false",
        "http.sslVerify=true",
        "protocol.allow=never",
        "protocol.https.allow=always",
        "submodule.recurse=false",
      ];
      const args = [
        ...configs.flatMap((config) => ["-c", config]),
        "clone",
        "--no-recurse-submodules",
        "--template=",
        "--",
        url,
        destination,
      ];
      await runClone(
        args,
        { cwd: scratch, env: cloneEnvironment(scratch) },
        this.cloneTimeoutMs,
        signal,
      );
      const project = {
        id: randomUUID(),
        name: folderName,
        path: destination,
        url,
        credentialId: credential?.id || null,
        createdAt: new Date().toISOString(),
      };
      this.projects.push(project);
      try {
        this.save();
      } catch {
        this.projects = this.projects.filter((item) => item.id !== project.id);
        throw problem(serverMessages.repositories.clonedProjectSaveFailed);
      }
      return { ...project };
    } catch (error) {
      // Check ownership again: never remove a pre-existing or replaced path.
      if (identity) {
        try {
          const current = fs.lstatSync(destination);
          if (
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            current.isDirectory()
          )
            fs.rmSync(destination, { recursive: true, force: true });
        } catch {
          /* Already absent or replaced. */
        }
      }
      if (error.status) throw error;
      throw problem(serverMessages.repositories.cloneTargetOrTokenFailed);
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
