import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { privateDirectory, writePrivate } from "../../../lib/storage.js";
import {
  codexCredentialStoreArgs,
  codexCredentialStoreConfig,
  pinCodexCredentialStores,
} from "../../providers/codex-credential-stores.js";

/** Environment that keeps one account's Codex state under `root`. */
export function profileEnv(root) {
  return { CODEX_HOME: privateDirectory(path.join(root, "codex")) };
}

export function configRoot(env, home) {
  return env.CODEX_HOME || path.join(env.HOME || home, ".codex");
}

export const dataRoot = configRoot;

export function parseAuthStatus(stdout, stderr, exitCode) {
  const output = stripVTControlCharacters(`${stdout || ""}\n${stderr || ""}`);
  if (exitCode === 0 && /^Logged in using .+/m.test(output)) return "authenticated";
  if (exitCode === 1 && /^Not logged in\s*$/m.test(output)) return "unauthenticated";
  return "unknown";
}

/**
 * Where a managed account keeps its Codex credentials: file stores inside CODEX_HOME
 * (see codex-credential-stores.js) and the API key in auth.json.
 * seedProfile(root, { apiKey, providerSelected }): a new account's file stores, and
 * its API key unless a provider serves it. storeApiKey(root, apiKey, {
 * providerSelected }): a rotated key, likewise. args(): the command-line overrides
 * every Codex process of the account takes. pin(launch, profileDir): repairs the
 * file stores in the launch's CODEX_HOME.
 */
export const credentials = {
  seedProfile(root, { apiKey, providerSelected }) {
    const dir = privateDirectory(path.join(root, "codex"));
    fs.writeFileSync(path.join(dir, "config.toml"), codexCredentialStoreConfig(), {
      mode: 0o600,
    });
    if (apiKey && !providerSelected)
      writePrivate(path.join(dir, "auth.json"), { OPENAI_API_KEY: apiKey });
  },
  storeApiKey(root, apiKey, { providerSelected }) {
    if (!providerSelected)
      writePrivate(path.join(root, "codex/auth.json"), {
        OPENAI_API_KEY: apiKey,
      });
  },
  args: codexCredentialStoreArgs,
  pin(launch, profileDir) {
    pinCodexCredentialStores(path.join(launch.env.CODEX_HOME, "config.toml"), profileDir);
  },
};
