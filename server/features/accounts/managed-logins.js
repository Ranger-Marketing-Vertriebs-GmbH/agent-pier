/*
 * Keeps the login of a managed account in the account folder when its CLI would use
 * the system keychain (Claude Code on macOS; `loginStore` in clis/drivers.js). The
 * account store asks this for the environment, the sandbox grant and the moment an
 * account may change store. Without it (AccountStore's default) every account keeps
 * the CLI's own behaviour.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

export const SECURITY = "/usr/bin/security";

/**
 * Runs the keychain tool and reports its exit code and output; rejects when it
 * cannot be run at all or does not answer. Nothing it prints is logged.
 */
export function runSecurity(args, { executable = SECURITY, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout, maxBuffer: 1 << 20, encoding: "utf8" },
      (error, stdout) => {
        if (!error) resolve({ code: 0, stdout });
        else if (Number.isInteger(error.code)) resolve({ code: error.code, stdout: "" });
        else reject(new Error("The keychain tool could not be run."));
      },
    );
  });
}

/** Writes the stand-in with `real` as the tool it passes other calls to. */
export function installShim(directory, { name, source }, real = SECURITY) {
  const text = fs
    .readFileSync(source, "utf8")
    .replace(/^real=.*$/m, `real='${real.replaceAll("'", "'\\''")}'`);
  const file = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {}
  if (current !== text) fs.writeFileSync(file, text, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return directory;
}

export class ManagedLogins {
  constructor({
    dataDir,
    platform = process.platform,
    run = runSecurity,
    running = async () => false,
    user = process.env.USER || os.userInfo().username,
    security = SECURITY,
  }) {
    this.dataDir = path.resolve(dataDir);
    this.platform = platform;
    this.run = run;
    this.running = running;
    this.user = user;
    this.security = security;
    this.shims = new Map();
  }
  /** The account's login store driver, or null when the CLI's own store stays. */
  store(account) {
    if (account.kind !== "managed" || !isCodingCli(account.tool)) return null;
    const store = cliDriver(account.tool).loginStore;
    return store?.supported(this.platform) ? store : null;
  }
  shimDirectory(tool, store) {
    if (!this.shims.has(tool))
      this.shims.set(
        tool,
        installShim(
          path.join(this.dataDir, "login-shims", tool),
          store.shim,
          this.security,
        ),
      );
    return this.shims.get(tool);
  }
  /** `env` for a process of the account: with the stand-in once it is on the file store. */
  environment(account, root, env) {
    const store = this.store(account);
    if (!store?.marked(root)) return env;
    return store.environment(env, this.shimDirectory(account.tool, store));
  }
  /** What a sandboxed session of the account must read: the stand-in's folder. */
  grants(account, root) {
    const store = this.store(account);
    if (!store?.marked(root)) return [];
    return [{ access: "read", path: this.shimDirectory(account.tool, store) }];
  }
  /** Moves the account to the file store when that is safe now (login-store.js). */
  async settle(account, root) {
    const store = this.store(account);
    if (!store) return null;
    return store.settle(root, {
      run: this.run,
      user: this.user,
      busy: () => this.running(account.id),
    });
  }
  /** Removes what the account may have left in the keychain; never rejects. */
  async forget(account, root) {
    const store = this.store(account);
    if (!store) return;
    await store.forget(root, { run: this.run, user: this.user }).catch(() => {});
  }
  /**
   * Whether a sandboxed session of `account` with the environment `env` cannot read
   * its login: "local" for the CLI's own profile, "pending" for a managed account
   * still on the keychain, else undefined. `env` decides too: an account's API key
   * and a provider connection reach the session as variables.
   */
  hiddenLogin(account, { home, root, env }) {
    if (!isCodingCli(account.tool)) return undefined;
    const store = cliDriver(account.tool).loginStore;
    if (!store?.supported(this.platform)) return undefined;
    if (account.kind === "local")
      return store.localHidden(home, env) ? "local" : undefined;
    if (account.provider || account.hasSecret) return undefined;
    return store.managedHidden(root, env) ? "pending" : undefined;
  }
}

/**
 * The application's instance. `config.keychainRun` replaces the keychain tool (test
 * fixtures refuse it); `sessions()` is the session manager, read per call.
 */
export const managedLogins = (config, sessions) =>
  new ManagedLogins({
    dataDir: config.dataDir,
    ...(config.keychainRun ? { run: config.keychainRun } : {}),
    running: async (id) =>
      (await sessions().list()).some(
        (session) => session.accountId === id && session.status === "running",
      ),
  });
