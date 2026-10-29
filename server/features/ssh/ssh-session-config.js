// Files that let a coding session reach its granted SSH hosts with plain OpenSSH: one
// alias per host in a generated ssh_config, a pinned known_hosts, the public keys the
// session agent serves, and `ssh`/`scp`/`sftp` wrappers that add `-F <config>` only
// when the destination (or a `-J` jump host) is a session alias. The config holds
// nothing but alias `Host` blocks, so it can also be included from a `Match exec`
// block of the user's config.
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "../../lib/launch-serialization.js";
import { privateFolder, writePrivateText } from "../../lib/storage.js";
import { legacyOptions } from "./ssh-legacy-algorithms.js";
import { endpoint, publicKeyValue } from "./ssh-keys.js";

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const keyIdPattern = /^[0-9a-f-]{36}$/;
const binaryNames = ["ssh", "scp", "sftp"];
const aliasLength = 40;

const validSessionId = (id) => typeof id === "string" && sessionIdPattern.test(id);
// Digit-only names read as ports or option values, and `localhost` is the loopback.
const reservedAlias = (alias) => /^\d+$/.test(alias) || alias === "localhost";
const validAlias = (alias) =>
  typeof alias === "string" && aliasPattern.test(alias) && !reservedAlias(alias);
const slug = (value) => value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cut = (value, length) => slug(value.slice(0, length));

/** The DNS-safe alias a host name suggests, before collisions are resolved. */
export function aliasBase(name, accessId) {
  const base = cut(slug(String(name ?? "").toLowerCase()), aliasLength);
  if (!base) return slug(`host-${String(accessId ?? "").slice(0, 8)}`.toLowerCase());
  return reservedAlias(base) ? cut(`host-${base}`, aliasLength) : base;
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
    for (let n = 2; taken.has(alias); n += 1)
      alias = `${cut(base, aliasLength - `-${n}`.length)}-${n}`;
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
        `HostName ${host.hostName.replaceAll("%", "%%")}`,
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

const uriPatterns = (scheme, alias) => [
  `${scheme}://${alias}`,
  `${scheme}://${alias}[:/]*`,
  `${scheme}://*@${alias}`,
  `${scheme}://*@${alias}[:/]*`,
];
const hostPortPatterns = (alias) => [alias, `${alias}:*`, `*@${alias}`, `*@${alias}:*`];

// Per tool: the option letters that take a value (OpenSSH getopt strings), which
// operands are destinations, and the shapes a destination naming an alias can take.
const wrapperRules = {
  ssh: {
    values: "BbcDEeFIiJLlmOoPpQRSWw",
    // The first operand is the destination; options may follow it, and the next
    // operand starts the remote command.
    operand: ['if [ "$seen" = 1 ]; then break; fi', "seen=1", "is_target"],
    targets: (alias) => [alias, `*@${alias}`, ...uriPatterns("ssh", alias)],
  },
  scp: {
    values: "cDFiJloPSX",
    // Options end at the first operand; every operand may be a remote path.
    operand: ["stop=1", "is_target"],
    targets: (alias) => [`${alias}:*`, `*@${alias}:*`, ...uriPatterns("scp", alias)],
  },
  sftp: {
    values: "BbcDFiJloPRSsX",
    operand: ["is_target", "break"],
    targets: (alias) => [...hostPortPatterns(alias), ...uriPatterns("sftp", alias)],
  },
};
const jumpPatterns = (alias) => [
  ...hostPortPatterns(alias),
  ...uriPatterns("ssh", alias),
];

// is_target: whether one operand is a destination that names a session alias.
const targetFunction = (patterns) => [
  "is_target() {",
  '  case "$1" in',
  `    ${patterns.join("|")}) return 0 ;;`,
  "  esac",
  "  return 1",
  "}",
];

/**
 * A POSIX sh wrapper around one OpenSSH binary (`tool` is ssh, scp or sftp). It parses
 * the options like OpenSSH and adds `-F <config>` only when the destination or a `-J`
 * jump host names a session alias and the caller did not pass its own `-F`; otherwise
 * it runs the binary with the arguments unchanged.
 */
export function renderWrapper({ tool, realPath, configPath: config, aliases }) {
  const rules = wrapperRules[tool];
  if (!rules) throw new Error("Unknown OpenSSH tool");
  if (!aliases.every(validAlias)) throw new Error("Invalid session SSH alias");
  const head = [
    "#!/bin/sh",
    `real=${shellQuote(realPath)}`,
    `config=${shellQuote(config)}`,
  ];
  if (!aliases.length) return [...head, 'exec "$real" "$@"', ""].join("\n");
  const operand = rules.operand.map((step) =>
    step === "is_target" ? 'if is_target "$a"; then hit=1; fi' : step,
  );
  return [
    ...head,
    ...targetFunction(aliases.flatMap(rules.targets)),
    "is_jump() {",
    "  j=$1",
    "  while :; do",
    '    case "${j%%,*}" in',
    `      ${aliases.flatMap(jumpPatterns).join("|")}) return 0 ;;`,
    "    esac",
    '    case "$j" in',
    "      *,*) j=${j#*,} ;;",
    "      *) return 1 ;;",
    "    esac",
    "  done",
    "}",
    "option_value() {",
    '  if [ "$1" = J ] && is_jump "$2"; then hit=1; fi',
    '  if [ "$1" = F ]; then own=1; fi',
    "}",
    "hit=0 own=0 seen=0 stop=0 want=",
    'for a in "$@"; do',
    '  if [ -n "$want" ]; then',
    '    option_value "$want" "$a"',
    "    want=",
    "    continue",
    "  fi",
    '  if [ "$stop" = 0 ] && [ "$a" = -- ]; then',
    "    stop=1",
    "    continue",
    "  fi",
    '  case "$stop$a" in',
    "    0-?*)",
    "      o=${a#-}",
    '      while [ -n "$o" ]; do',
    '        c=${o%"${o#?}"}',
    "        o=${o#?}",
    '        case "$c" in',
    `          [${rules.values}])`,
    '            if [ -n "$o" ]; then option_value "$c" "$o"; else want=$c; fi',
    "            break",
    "            ;;",
    "        esac",
    "      done",
    "      continue",
    "      ;;",
    "  esac",
    ...operand.map((line) => `  ${line}`),
    "done",
    'if [ "$hit" = 1 ] && [ "$own" = 0 ]; then exec "$real" -F "$config" "$@"; fi',
    'exec "$real" "$@"',
    "",
  ].join("\n");
}

function realPathOrNull(file) {
  try {
    return fs.realpathSync(file);
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
 * The executable `ssh`, `scp` and `sftp` on `pathEnv`. Relative entries are ignored,
 * and so is every candidate whose real path lies in or under a `skip` root (pass
 * `<dataDir>/ssh/agents` to skip all session wrappers, also through symlinks).
 * `scp` and `sftp` come from the folder of the chosen `ssh` when it has them.
 * Returns the binaries it finds, or null when there is no `ssh`.
 */
export function resolveOpenSshBinaries(pathEnv, skip = []) {
  const roots = skip.map(realPathOrNull).filter(Boolean);
  const inside = (real) =>
    roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
  const usable = (file) => {
    const real = realPathOrNull(file);
    return Boolean(real) && !inside(real) && executableFile(file);
  };
  const dirs = String(pathEnv ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir) && !inside(realPathOrNull(dir) ?? dir));
  const sshDir = dirs.find((dir) => usable(path.join(dir, "ssh")));
  if (!sshDir) return null;
  const found = {};
  for (const name of binaryNames) {
    const dir = [sshDir, ...dirs].find((entry) => usable(path.join(entry, name)));
    if (dir) found[name] = path.join(dir, name);
  }
  return found;
}

/** `<dataDir>/ssh/agents/<sessionId>`; throws for an id that is not a plain name. */
export function sessionFolder(dataDir, sessionId) {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id");
  return path.join(path.resolve(dataDir), "ssh", "agents", sessionId);
}

const unsafeFolder = () =>
  Object.assign(new Error("Unsafe session SSH folder"), { code: "SSH_FOLDER_UNSAFE" });

// Unlink entries of a verified folder that are not in `keep`. Files and symlinks are
// unlinked (a link is never followed); directories are left alone.
function removeOthers(dir, keep) {
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name)) continue;
    const entry = path.join(dir, name);
    if (!fs.lstatSync(entry).isDirectory()) fs.unlinkSync(entry);
  }
}

/**
 * Write the session's config, known_hosts, public keys, alias map and wrappers.
 * Folders are created without following symlinks and refused when one is planted;
 * every file goes through an exclusive temp name and a rename; files no longer needed
 * are unlinked. Returns the access ids of hosts that could not be rendered (invalid
 * fields, no alias or a duplicate alias), which get no alias.
 */
export function writeSessionFiles(folder, { hosts, aliases, socketPath, binaries }) {
  const list = Array.isArray(hosts) ? hosts : [];
  const usable = renderableHosts(list, aliases);
  const config = path.join(folder, "ssh_config");
  const configText = renderSshConfig({ hosts: list, aliases, folder, socketPath });
  const wrappers = binaryNames
    .filter((name) => typeof binaries?.[name] === "string")
    .filter((name) => path.isAbsolute(binaries[name]))
    .map((name) => [
      name,
      renderWrapper({
        tool: name,
        realPath: binaries[name],
        configPath: config,
        aliases: usable.map((host) => host.alias),
      }),
    ]);
  fs.mkdirSync(path.dirname(path.dirname(folder)), { recursive: true, mode: 0o700 });
  privateFolder(path.dirname(folder), unsafeFolder);
  privateFolder(folder, unsafeFolder);
  const keys = privateFolder(path.join(folder, "keys"), unsafeFolder);
  const bin = privateFolder(path.join(folder, "bin"), unsafeFolder);
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
    renderKnownHosts({ hosts: list, aliases }),
  );
  writePrivateText(config, configText);
  for (const [name, script] of wrappers)
    writePrivateText(path.join(bin, name), script, 0o700);
  removeOthers(bin, new Set(wrappers.map(([name]) => name)));
  const written = Object.fromEntries(usable.map((host) => [host.accessId, host.alias]));
  writePrivateText(
    path.join(folder, "aliases.json"),
    `${JSON.stringify(written, null, 2)}\n`,
  );
  const rendered = new Set(usable.map((host) => host.accessId));
  return {
    skipped: list.map((host) => host?.accessId).filter((id) => !rendered.has(id)),
  };
}

/** The alias map of a session's folder; empty when missing, unreadable or invalid. */
export function readSessionAliases(dataDir, sessionId) {
  if (!validSessionId(sessionId)) return {};
  let value;
  let fd;
  try {
    const file = path.join(sessionFolder(dataDir, sessionId), "aliases.json");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    value = JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, alias]) => validAlias(alias)),
  );
}
