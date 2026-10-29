// Files that let a coding session reach its granted SSH hosts with plain OpenSSH: one
// alias per host in a generated ssh_config, a pinned known_hosts, the public keys the
// session agent serves, and `ssh`/`scp`/`sftp` wrappers that add `-F <config>` only
// when an argument names a session alias. The config holds nothing but alias `Host`
// blocks, so it can also be included from a `Match exec` block of the user's config.
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "../../lib/launch-serialization.js";
import { privateDirectory, writePrivate, writePrivateText } from "../../lib/storage.js";
import { legacyOptions } from "./ssh-legacy-algorithms.js";
import { endpoint, publicKeyValue } from "./ssh-keys.js";

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const keyIdPattern = /^[0-9a-f-]{36}$/;
const binaryNames = ["ssh", "scp", "sftp"];
const aliasBaseLength = 40;

const validSessionId = (id) => typeof id === "string" && sessionIdPattern.test(id);
const validAlias = (alias) => typeof alias === "string" && aliasPattern.test(alias);

/** The DNS-safe alias a host name suggests, before collisions are resolved. */
export function aliasBase(name, accessId) {
  const slug = (value) => value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = slug(slug(String(name ?? "").toLowerCase()).slice(0, aliasBaseLength));
  return base || slug(`host-${String(accessId ?? "").slice(0, 8)}`.toLowerCase());
}

const byAge = (a, b) => {
  const ageA = String(a.createdAt ?? "");
  const ageB = String(b.createdAt ?? "");
  if (ageA !== ageB) return ageA < ageB ? -1 : 1;
  return a.accessId < b.accessId ? -1 : a.accessId > b.accessId ? 1 : 0;
};

/**
 * One alias per host, keyed by access id. A host keeps its previous alias while it is
 * present; new hosts take their base alias or the next free `-2`, `-3`, … in order of
 * `createdAt`, then access id.
 */
export function sessionAliases(hosts, previous = {}) {
  const taken = new Set();
  const assigned = new Map();
  const ordered = [...hosts].sort(byAge);
  for (const host of ordered) {
    const alias = previous?.[host.accessId];
    if (validAlias(alias) && !taken.has(alias)) {
      taken.add(alias);
      assigned.set(host.accessId, alias);
    }
  }
  for (const host of ordered) {
    if (assigned.has(host.accessId)) continue;
    const base = aliasBase(host.name, host.accessId);
    let alias = base;
    for (let n = 2; taken.has(alias); n += 1) alias = `${base}-${n}`;
    taken.add(alias);
    assigned.set(host.accessId, alias);
  }
  return Object.fromEntries(
    hosts.map((host) => [host.accessId, assigned.get(host.accessId)]),
  );
}

// A host whose fields all fit into config lines, or null. Catalog rows are validated
// on write already; this keeps a damaged row from ever adding a config line.
function renderable(host, aliases) {
  const alias = aliases?.[host?.accessId];
  if (!validAlias(alias)) return null;
  if (typeof host.keyId !== "string" || !keyIdPattern.test(host.keyId)) return null;
  try {
    const { host: hostName, port, username } = endpoint(host);
    if (!username) return null;
    return {
      accessId: host.accessId,
      alias,
      hostName,
      port,
      username,
      keyId: host.keyId,
      publicKey: publicKeyValue(host.publicKey),
      hostKey: publicKeyValue(host.hostKey),
      legacy: host.legacy === true,
    };
  } catch {
    return null;
  }
}

// Hosts that can be rendered, each alias once (the first host keeps it).
function renderableHosts(hosts, aliases) {
  const seen = new Set();
  return (Array.isArray(hosts) ? hosts : [])
    .map((host) => renderable(host, aliases))
    .filter((host) => host && !seen.has(host.alias) && seen.add(host.alias));
}

// A double-quoted ssh_config path: `%` is escaped from token expansion; `${` (env
// expansion), control characters and relative paths are refused.
function configPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.includes("${")
  )
    throw new Error("Unsupported path for the session SSH config");
  return `"${value.replace(/[\\"]/g, "\\$&").replaceAll("%", "%%")}"`;
}

/** The session ssh_config: one hardened block per alias, nothing else. */
export function renderSshConfig({ hosts, aliases, folder, socketPath }) {
  const agent = configPath(socketPath);
  const knownHosts = configPath(path.join(folder, "known_hosts"));
  return renderableHosts(hosts, aliases)
    .map((host) =>
      [
        `Host ${host.alias}`,
        `HostName ${host.hostName}`,
        `Port ${host.port}`,
        `User ${host.username}`,
        `HostKeyAlias ${host.alias}`,
        `IdentityAgent ${agent}`,
        `IdentityFile ${configPath(path.join(folder, "keys", `${host.keyId}.pub`))}`,
        "IdentitiesOnly yes",
        "BatchMode yes",
        "StrictHostKeyChecking yes",
        `UserKnownHostsFile ${knownHosts}`,
        "GlobalKnownHostsFile /dev/null",
        "UpdateHostKeys no",
        "CheckHostIP no",
        "VerifyHostKeyDNS no",
        "ForwardAgent no",
        "ForwardX11 no",
        "ControlMaster no",
        "ControlPath none",
        "ProxyCommand none",
        "ProxyJump none",
        "PermitLocalCommand no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PreferredAuthentications publickey",
        "GatewayPorts no",
        "ExitOnForwardFailure yes",
        "ConnectTimeout 10",
        "ConnectionAttempts 1",
        "ServerAliveInterval 30",
        ...(host.legacy ? legacyOptions.map((option) => option.replace("=", " ")) : []),
      ]
        .map((line, index) => (index ? `  ${line}` : line))
        .join("\n"),
    )
    .map((block) => `${block}\n`)
    .join("\n");
}

/** The pinned known_hosts: `<alias> <host key>` per alias. */
export function renderKnownHosts({ hosts, aliases }) {
  return renderableHosts(hosts, aliases)
    .map((host) => `${host.alias} ${host.hostKey}\n`)
    .join("");
}

/**
 * A POSIX sh wrapper around one OpenSSH binary. It adds `-F <config>` only when an
 * argument names a session alias and otherwise runs the binary unchanged.
 */
export function renderWrapper({ realPath, configPath: config, aliases }) {
  if (!aliases.every(validAlias)) throw new Error("Invalid session SSH alias");
  const patterns = aliases.flatMap((alias) => [
    alias,
    `${alias}:*`,
    `*@${alias}`,
    `*@${alias}:*`,
    `ssh://${alias}`,
    `ssh://${alias}[:/]*`,
    `ssh://*@${alias}`,
    `ssh://*@${alias}[:/]*`,
  ]);
  const match = patterns.length
    ? [
        'for a in "$@"; do',
        '  case "$a" in',
        `    ${patterns.join("|")}) exec "$real" -F "$config" "$@" ;;`,
        "  esac",
        "done",
      ]
    : [];
  return [
    "#!/bin/sh",
    `real=${shellQuote(realPath)}`,
    `config=${shellQuote(config)}`,
    ...match,
    'exec "$real" "$@"',
    "",
  ].join("\n");
}

function realDirectory(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

function executableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first executable `ssh`, `scp` and `sftp` on `pathEnv`, skipping relative entries
 * and the directories in `skip` (the session's own wrappers, also through symlinks).
 * Returns the binaries it finds, or null when there is no `ssh`.
 */
export function resolveOpenSshBinaries(pathEnv, skip = []) {
  const skipped = new Set(skip.map(realDirectory).filter(Boolean));
  const found = {};
  for (const dir of String(pathEnv ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const real = realDirectory(dir);
    if (!real || skipped.has(real)) continue;
    for (const name of binaryNames) {
      const file = path.join(dir, name);
      if (!found[name] && executableFile(file)) found[name] = file;
    }
  }
  if (!found.ssh) return null;
  return Object.fromEntries(
    binaryNames.filter((n) => found[n]).map((n) => [n, found[n]]),
  );
}

/** `<dataDir>/ssh/agents/<sessionId>`; throws for an id that is not a plain name. */
export function sessionFolder(dataDir, sessionId) {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id");
  return path.join(path.resolve(dataDir), "ssh", "agents", sessionId);
}

function removeOthers(dir, keep) {
  for (const name of fs.readdirSync(dir))
    if (!keep.has(name))
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
}

/**
 * Write the session's config, known_hosts, public keys, alias map and wrappers. Every
 * file goes through a temp name and a rename; files no longer needed are removed.
 */
export function writeSessionFiles(folder, { hosts, aliases, socketPath, binaries }) {
  const usable = renderableHosts(hosts, aliases);
  const config = path.join(folder, "ssh_config");
  const configText = renderSshConfig({ hosts, aliases, folder, socketPath });
  privateDirectory(folder);
  const keys = privateDirectory(path.join(folder, "keys"));
  const bin = privateDirectory(path.join(folder, "bin"));
  const keyFiles = new Set();
  for (const host of usable) {
    const name = `${host.keyId}.pub`;
    if (keyFiles.has(name)) continue;
    keyFiles.add(name);
    writePrivateText(path.join(keys, name), `${host.publicKey}\n`);
  }
  removeOthers(keys, keyFiles);
  writePrivateText(
    path.join(folder, "known_hosts"),
    renderKnownHosts({ hosts, aliases }),
  );
  writePrivateText(config, configText);
  const wrappers = new Set();
  for (const name of binaryNames) {
    const realPath = binaries?.[name];
    if (typeof realPath !== "string" || !path.isAbsolute(realPath)) continue;
    wrappers.add(name);
    const script = renderWrapper({
      realPath,
      configPath: config,
      aliases: usable.map((host) => host.alias),
    });
    writePrivateText(path.join(bin, name), script, 0o700);
  }
  removeOthers(bin, wrappers);
  const written = Object.fromEntries(usable.map((host) => [host.accessId, host.alias]));
  writePrivate(path.join(folder, "aliases.json"), written);
}

/** The alias map of a session's folder; empty when missing, unreadable or invalid. */
export function readSessionAliases(dataDir, sessionId) {
  if (!validSessionId(sessionId)) return {};
  let value;
  try {
    const file = path.join(sessionFolder(dataDir, sessionId), "aliases.json");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, alias]) => validAlias(alias)),
  );
}
