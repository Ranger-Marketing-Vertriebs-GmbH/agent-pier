import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { toolBinDirectories } from "../tools/tool-paths.js";
import { randomUUID } from "node:crypto";
import { connectionProfile } from "../providers/connection-profile.js";
import { ProviderCatalog } from "../providers/provider-catalog.js";
import { validateProviderSelection } from "../providers/provider-definitions.js";
import { providerEnvironment } from "../providers/provider-environment.js";
import { prepareProviderLaunch } from "../providers/provider-launch.js";
import {
  privateDirectory,
  writePrivate,
  readJSON,
  problem,
  nameValue,
} from "../../lib/storage.js";
const TOOLS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "opencode", name: "OpenCode" },
];
const SHELL = { id: "shell", name: "Shell" };
const LAUNCH_ARGS = {
  codex: { default: [], yolo: ["--yolo"] },
  claude: { default: [], auto: ["--permission-mode", "auto"] },
  opencode: { default: [], auto: ["--auto"] },
  shell: { default: ["-l"] },
};
function shellPath(file) {
  return (
    typeof file === "string" &&
    path.isAbsolute(file) &&
    ["zsh", "bash", "sh"].includes(path.basename(file)) &&
    !file.includes("\0")
  );
}
function shellExecutable(file) {
  if (!shellPath(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
export function resolveShell(env = process.env, available = shellExecutable) {
  return (
    [
      env.SHELL,
      "/bin/zsh",
      "/usr/bin/zsh",
      "/bin/bash",
      "/usr/bin/bash",
      "/bin/sh",
      "/usr/bin/sh",
    ].find((file) => shellPath(file) && available(file)) || null
  );
}
export function cleanEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ])
    if (typeof source[key] === "string") env[key] = source[key];
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}
function detectExecutables(tools, env, common, additionalDirectories) {
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  if (common)
    dirs.push(
      path.join(env.HOME || os.homedir(), ".local/bin"),
      path.join(env.HOME || os.homedir(), ".opencode/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  dirs.push(...additionalDirectories);
  return tools.map((tool) => {
    let executable = null;
    for (const dir of dirs) {
      const file = path.resolve(dir, tool.id);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) {
          executable = file;
          break;
        }
      } catch {}
    }
    return { ...tool, installed: !!executable, path: executable };
  });
}
export function detectUtilities(
  env = process.env,
  common = true,
  additionalDirectories = [],
) {
  return detectExecutables(
    [{ id: "gh", name: "GitHub CLI", utility: true }],
    env,
    common,
    additionalDirectories,
  );
}
export function detectTools(
  env = process.env,
  common = true,
  additionalDirectories = [],
) {
  const coding = detectExecutables(TOOLS, env, common, additionalDirectories);
  const shell = resolveShell(env);
  return [...coding, { ...SHELL, installed: !!shell, path: shell }];
}
function removeCodexApiKey(root) {
  const file = path.join(root, "codex/auth.json");
  const auth = readJSON(file, null);
  if (!auth || typeof auth.OPENAI_API_KEY !== "string") return;
  const remaining = { ...auth };
  delete remaining.OPENAI_API_KEY;
  if (Object.keys(remaining).length) writePrivate(file, remaining);
  else fs.rmSync(file, { force: true });
}
export class AccountStore {
  constructor({ dataDir, home = os.homedir(), providerCatalog, providerConnections }) {
    this.dataDir = privateDirectory(path.resolve(dataDir));
    this.home = home;
    this.file = path.join(dataDir, "accounts.json");
    this.accounts = readJSON(this.file, []);
    this.providerCatalog = providerCatalog || new ProviderCatalog({ dataDir });
    this.providerConnections = providerConnections;
  }
  list() {
    return [
      ...[...TOOLS, SHELL].map((t) => ({
        id: `local-${t.id}`,
        name: serverMessages.accounts.localAccountName(t.name),
        tool: t.id,
        kind: "local",
        hasSecret: false,
        createdAt: null,
      })),
      ...this.accounts.filter((a) => !a.internal).map((a) => structuredClone(a)),
    ];
  }
  get(id) {
    const a =
      this.accounts.find((a) => a.id === id) || this.list().find((a) => a.id === id);
    if (!a) throw problem(serverMessages.accounts.notFound, 404);
    return structuredClone(a);
  }
  connectionProfile(input) {
    return connectionProfile(this, input);
  }
  secret(account) {
    return account.internal?.kind === "provider-connection"
      ? this.providerConnections?.secret(account.internal.connectionId) || null
      : readJSON(path.join(this.profile(account.id), "secret.json"), null);
  }
  profile(id) {
    const a = this.get(id);
    if (a.kind !== "managed") throw problem(serverMessages.accounts.localProfileReadOnly);
    return path.join(this.dataDir, "profiles", a.id);
  }
  save() {
    writePrivate(this.file, this.accounts);
  }
  create({ name, tool, apiKey, provider } = {}) {
    name = nameValue(name);
    if (!TOOLS.some((t) => t.id === tool))
      throw problem(serverMessages.common.unknownCliTool);
    if (
      apiKey !== undefined &&
      (typeof apiKey !== "string" || apiKey.length > 16384 || /[\x00-\x1f]/.test(apiKey))
    )
      throw problem(serverMessages.accounts.invalidApiKey);
    const key = apiKey?.trim();
    const selection = validateProviderSelection(provider, tool, this.providerCatalog);
    const a = {
      id: randomUUID(),
      name,
      tool,
      kind: "managed",
      hasSecret: !!key,
      createdAt: new Date().toISOString(),
      ...(selection ? { provider: selection } : {}),
    };
    const root = privateDirectory(path.join(this.dataDir, "profiles", a.id));
    if (key) writePrivate(path.join(root, "secret.json"), { apiKey: key });
    if (tool === "codex") {
      const dir = privateDirectory(path.join(root, "codex"));
      fs.writeFileSync(
        path.join(dir, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
      if (key && !selection)
        writePrivate(path.join(dir, "auth.json"), { OPENAI_API_KEY: key });
    }
    this.accounts.push(a);
    this.save();
    this.environment(a.id);
    return structuredClone(a);
  }
  update(id, { name, apiKey, provider, removeApiKey = false } = {}) {
    if (this.get(id).internal)
      throw problem("Generated provider profiles cannot be edited.", 409);
    const root = this.profile(id);
    name = nameValue(name);
    if (
      apiKey !== undefined &&
      (typeof apiKey !== "string" || apiKey.length > 16384 || /[\x00-\x1f]/.test(apiKey))
    )
      throw problem(serverMessages.accounts.invalidApiKey);
    const a = this.accounts.find((a) => a.id === id);
    const key = apiKey?.trim();
    if (typeof removeApiKey !== "boolean" || (removeApiKey && key))
      throw problem("Choose either key rotation or key removal.");
    const selection =
      provider === undefined
        ? a.provider
        : validateProviderSelection(provider, a.tool, this.providerCatalog);
    if (selection?.id !== a.provider?.id && a.hasSecret && !key && !removeApiKey)
      throw problem(
        "Supply a new API key or remove the saved key when switching providers.",
        409,
      );
    if (selection) a.provider = selection;
    else delete a.provider;
    if (removeApiKey) {
      fs.rmSync(path.join(root, "secret.json"), { force: true });
      a.hasSecret = false;
    }
    if (removeApiKey || selection) removeCodexApiKey(root);
    if (key) {
      writePrivate(path.join(root, "secret.json"), { apiKey: key });
      if (a.tool === "codex" && !selection)
        writePrivate(path.join(root, "codex/auth.json"), {
          OPENAI_API_KEY: key,
        });
      a.hasSecret = true;
    }
    a.name = name;
    this.save();
    return structuredClone(a);
  }
  remove(id) {
    if (this.get(id).internal)
      throw problem(
        "Generated provider profiles retain session history and cannot be removed as accounts.",
        409,
      );
    const dir = this.profile(id);
    fs.rmSync(dir, { recursive: true, force: true });
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.save();
  }
  environment(id) {
    const account = this.get(id);
    const env = { ...cleanEnvironment(), HOME: this.home };
    if (account.tool === "shell") return env;
    env.PATH = [
      path.dirname(process.execPath),
      env.PATH || "",
      ...toolBinDirectories(this.dataDir),
    ]
      .filter(Boolean)
      .join(path.delimiter);
    if (account.kind === "local") return env;
    const root = this.profile(id);
    const secret = this.secret(account);
    if (account.provider) return providerEnvironment(account, secret, env, root);
    if (account.tool === "codex")
      env.CODEX_HOME = privateDirectory(path.join(root, "codex"));
    if (account.tool === "claude") {
      env.CLAUDE_CONFIG_DIR = privateDirectory(path.join(root, "claude"));
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    }
    if (account.tool === "opencode")
      for (const [k, dir] of Object.entries({
        XDG_CONFIG_HOME: "config",
        XDG_DATA_HOME: "data",
        XDG_STATE_HOME: "state",
        XDG_CACHE_HOME: "cache",
      }))
        env[k] = privateDirectory(path.join(root, dir));
    if (secret?.apiKey)
      env[account.tool === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] =
        secret.apiKey;
    return env;
  }
  command(id, executables, login = false, launchMode = "default", { modelId } = {}) {
    let account = this.get(id);
    if (modelId) {
      if (
        typeof modelId !== "string" ||
        modelId.length > 300 ||
        /[\x00-\x1f]/.test(modelId)
      )
        throw problem("Invalid profile model.");
      if (account.provider)
        account = {
          ...account,
          provider: validateProviderSelection(
            { ...account.provider, modelId },
            account.tool,
            this.providerCatalog,
          ),
        };
    }
    if (login && account.provider)
      throw problem(
        "Provider profiles use API keys and cannot start an OAuth login.",
        409,
      );
    if (
      typeof launchMode !== "string" ||
      !Object.hasOwn(LAUNCH_ARGS[account.tool], launchMode)
    )
      throw problem(serverMessages.accounts.invalidLaunchMode);
    if (login && launchMode !== "default")
      throw problem(serverMessages.accounts.launchModeRequiresWorkSession);
    if (login && account.kind === "local")
      throw problem(serverMessages.accounts.managedLoginRequired);
    if (login && account.hasSecret)
      throw problem(serverMessages.accounts.apiKeyLoginConflict, 409);
    const command = executables[account.tool];
    if (!command)
      throw problem(serverMessages.accounts.cliNotInstalled(account.tool), 409);
    if (account.tool === "shell" && !shellExecutable(command))
      throw problem(serverMessages.accounts.supportedShellUnavailable, 409);
    const args = login
      ? {
          codex: ["login", "--device-auth"],
          claude: [],
          opencode: ["auth", "login"],
        }[account.tool]
      : [...LAUNCH_ARGS[account.tool][launchMode]];
    const launch = {
      command,
      args,
      env: {
        ...this.environment(id),
        ...(account.tool === "shell" ? { SHELL: command } : {}),
      },
      launchMode,
    };
    if (!account.provider) {
      if (modelId) launch.args.push("--model", modelId);
      return launch;
    }
    const root = this.profile(id);
    return prepareProviderLaunch(account, this.secret(account), launch, {
      root,
      catalog: this.providerCatalog,
    });
  }
}
