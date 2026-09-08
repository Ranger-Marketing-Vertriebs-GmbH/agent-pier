import { isMainModule } from "../../lib/is-main-module.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { shellQuote as quote } from "../../lib/launch-serialization.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as toolDetection from "../accounts/account-store.js";
import { problem } from "../../lib/storage.js";
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
} from "../../../vendor/agentbus/core/fsx.js";
const modulePath = fileURLToPath(import.meta.url);
const disabledToken = "agentpier-disabled-no-token";
const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

const tokenKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_REPO",
  "GH_DEBUG",
];
// Native gh rejects ports and normalizes github.com / ghe.com API subdomains.
// Only canonical host names can therefore have independent credentials.
function nativeHost(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !host ||
      !/^[a-z0-9.-]+$/.test(host)
    )
      return null;
    if (
      host.endsWith(".github.com") ||
      (host.endsWith(".ghe.com") && host.split(".").length !== 3)
    )
      return null;
    return host;
  } catch {
    return null;
  }
}
export class GithubCredentials {
  constructor({ dataDir, repositories, resolveGh } = {}) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = path.join(this.dataDir, "github-sessions");
    this.repositories = repositories;
    this.resolveGh =
      resolveGh ||
      ((env) =>
        toolDetection
          .detectUtilities?.(env)
          ?.find((tool) => tool.id === "gh" && tool.installed)?.path || null);
  }
  folder(id) {
    if (!validId(id)) throw problem(serverMessages.common.invalidSessionId);
    return path.join(this.directory, id);
  }
  selections(cwd) {
    const selected = new Map();
    const entries = this.repositories.listCredentials();
    for (const entry of entries) {
      const host = nativeHost(entry.host);
      if (host && entry.agentDefault) selected.set(host, entry.id);
    }
    const candidates = this.repositories
      .listProjects()
      .flatMap((project) => {
        try {
          const root = fs.realpathSync(project.path);
          return cwd === root || cwd.startsWith(root + path.sep)
            ? [{ ...project, canonical: root }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.canonical.length - a.canonical.length);
    const project = candidates[0];
    if (project) {
      const entry = entries.find((item) => item.id === project.credentialId);
      let projectHost;
      try {
        projectHost = new URL(project.url).origin;
      } catch {}
      const host = entry && entry.host === projectHost && nativeHost(entry.host);
      if (host) selected.set(host, entry.id);
    }
    return [...selected].map(([host, credentialId]) => ({
      host,
      credentialId,
    }));
  }
  write(folder, selections) {
    const hosts = {};
    const entries = this.repositories.listCredentials();
    for (const selection of selections) {
      hosts[selection.host] = {
        oauth_token: disabledToken,
        git_protocol: "https",
      };
      const entry = entries.find((item) => item.id === selection.credentialId);
      if (!entry || nativeHost(entry.host) !== selection.host) continue;
      try {
        const secret = readJson(this.repositories.secretFile(entry.id));
        if (
          typeof secret.token !== "string" ||
          !secret.token ||
          secret.token.length > 16384 ||
          /[\x00-\x1f\x7f]/.test(secret.token)
        )
          continue;
        hosts[selection.host] = {
          oauth_token: secret.token,
          git_protocol: "https",
        };
      } catch {
        /* Missing or replaced secrets revoke this session copy. */
      }
    }
    writeJsonAtomic(path.join(folder, "hosts.yml"), hosts);
  }
  async prepare({ id, account, cwd, launch, purpose } = {}) {
    if (purpose === "login" || !["claude", "codex", "opencode"].includes(account?.tool))
      return launch;
    const canonical = fs.realpathSync(cwd);
    const folder = this.folder(id);
    ensureDir(this.directory);
    if (fs.existsSync(folder))
      throw problem(serverMessages.repositories.sessionConfigAlreadyExists, 409);
    ensureDir(folder);
    const selections = this.selections(canonical);
    const env = { ...launch.env };
    for (const key of tokenKeys) delete env[key];
    env.GH_CONFIG_DIR = folder;
    env.PATH = [
      ...(env.PATH || "").split(path.delimiter),
      path.join(this.dataDir, "clis/gh/bin"),
    ]
      .filter((value, index, items) => value && items.indexOf(value) === index)
      .join(path.delimiter);
    // Native schema version prevents automatic migration and username API calls.
    writeJsonAtomic(path.join(folder, "config.yml"), { version: 1 });
    writeJsonAtomic(path.join(folder, "selection.json"), { id, selections });
    this.write(folder, selections);
    const gh = this.resolveGh(env);
    if (gh) {
      env.PATH = [path.dirname(gh), ...(env.PATH || "").split(path.delimiter)]
        .filter((value, index, items) => value && items.indexOf(value) === index)
        .join(path.delimiter);
    }
    {
      let count = Number(env.GIT_CONFIG_COUNT || 0);
      if (!Number.isSafeInteger(count) || count < 0 || count > 256)
        throw problem(serverMessages.repositories.invalidTemporaryGitConfig);
      const helper = `!${quote(process.execPath)} ${quote(modulePath)} --git-credential`;
      for (const { host } of selections)
        for (const value of ["", helper]) {
          env[`GIT_CONFIG_KEY_${count}`] = `credential.https://${host}.helper`;
          env[`GIT_CONFIG_VALUE_${count}`] = value;
          count++;
        }
      env.GIT_CONFIG_COUNT = String(count);
    }
    return { ...launch, env };
  }
  disable(folder) {
    // Metadata is no longer trustworthy. First make native gh reject this config,
    // then remove every cached credential; retain only inert host placeholders.
    ensureDir(folder);
    writeJsonAtomic(path.join(folder, "config.yml"), {
      version: "agentpier-disabled",
    });
    let previous = {};
    try {
      previous = readJson(path.join(folder, "hosts.yml"));
    } catch {}
    const hosts = {};
    if (previous && typeof previous === "object")
      for (const host of Object.keys(previous))
        if (nativeHost(`https://${host}`) === host)
          hosts[host] = { oauth_token: disabledToken, git_protocol: "https" };
    writeJsonAtomic(path.join(folder, "hosts.yml"), hosts);
  }
  async sync() {
    let names;
    try {
      ensureDir(this.directory);
      names = fs.readdirSync(this.directory);
    } catch (error) {
      throw problem(serverMessages.repositories.sessionConfigUnavailable, 409);
    }
    let failed = false;
    for (const id of names) {
      if (!validId(id)) continue;
      const folder = this.folder(id);
      let record;
      try {
        const stat = fs.lstatSync(folder);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        record = readJson(path.join(folder, "selection.json"));
      } catch {}
      const valid =
        record?.id === id &&
        Array.isArray(record.selections) &&
        record.selections.length <= 1000 &&
        record.selections.every(
          (item) =>
            validId(item?.credentialId) &&
            nativeHost(`https://${item.host}`) === item.host,
        );
      try {
        if (valid) {
          this.write(folder, record.selections);
          writeJsonAtomic(path.join(folder, "config.yml"), { version: 1 });
        } else this.disable(folder);
      } catch {
        failed = true;
      }
    }
    if (failed) throw problem(serverMessages.repositories.sessionConfigUpdateFailed, 409);
  }

  async discard(id) {
    const folder = this.folder(id);
    try {
      const stat = fs.lstatSync(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      if (readJson(path.join(folder, "selection.json")).id !== id) return;
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        throw problem(serverMessages.repositories.sessionConfigRemoveFailed, 409);
    }
  }
}
// An inert value for revoked hosts prevents native gh falling back to the
// global keychain. Our helper rejects it and returns no credentials.
// Unlike gh's helper this deliberately never falls back to the system keyring
// after a configured token has been revoked. It accepts only exact HTTPS hosts.
export function gitCredential(input, env = process.env, operation = "get") {
  if (operation !== "get" || input.length > 65536) return "";
  const fields = {};
  for (const line of input.split("\n")) {
    if (!line) break;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    if (Object.hasOwn(fields, key)) return "";
    fields[key] = line.slice(at + 1);
  }
  if (
    fields.protocol !== "https" ||
    !fields.host ||
    nativeHost(`https://${fields.host}`) !== fields.host
  )
    return "";
  try {
    const folder = env.GH_CONFIG_DIR;
    if (
      !path.isAbsolute(folder) ||
      path.basename(path.dirname(folder)) !== "github-sessions" ||
      !validId(path.basename(folder))
    )
      return "";
    const selection = readJson(path.join(folder, "selection.json"));
    if (
      selection.id !== path.basename(folder) ||
      !Array.isArray(selection.selections) ||
      !selection.selections.some(
        (item) => item?.host === fields.host && validId(item.credentialId),
      )
    )
      return "";
    const hosts = readJson(path.join(folder, "hosts.yml"));
    const token = hosts[fields.host]?.oauth_token;
    if (
      typeof token !== "string" ||
      !token ||
      token === disabledToken ||
      /[\x00-\x1f\x7f]/.test(token)
    )
      return "";
    return `username=x-access-token\npassword=${token}\n\n`;
  } catch {
    return "";
  }
}
export async function runGitCredentialCommand() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) break;
  }
  process.stdout.write(gitCredential(input, process.env, process.argv[3]));
}

if (isMainModule(import.meta.url) && process.argv[2] === "--git-credential") {
  await runGitCredentialCommand();
}
