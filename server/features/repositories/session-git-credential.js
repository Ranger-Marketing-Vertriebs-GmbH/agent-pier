// The git credential helper of agent sessions, started through the stable
// server/github-credentials.js entry point. git runs it as a subprocess on every
// HTTPS authentication, so its import graph stays limited to Node built-ins and
// small local modules; it never loads the server or npm packages.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "../../../vendor/agentbus/core/fsx.js";
import {
  maxCredentialRequestLength,
  parseCredentialRequest,
} from "./git-credential-request.js";

export const disabledToken = "agentpier-disabled-no-token";
export const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

// Native gh rejects ports and normalizes github.com / ghe.com API subdomains.
// Only canonical host names can therefore have independent credentials.
export function nativeHost(origin) {
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

// An inert value for revoked hosts prevents native gh falling back to the
// global keychain. Our helper rejects it and returns no credentials.
// Unlike gh's helper this deliberately never falls back to the system keyring
// after a configured token has been revoked. It accepts only canonical HTTPS hosts
// and the gist subdomain of a selected host. When it prints no credential, it
// names the cause and the fix on stderr, and the helper that follows it in the
// session's git configuration tells git to quit instead of prompting inside the
// agent's pane. The text is native diagnostic output and stays in English.
const settings = "Settings → Access → GitHub connections";
const reload = "reload the session in AgentPier";
const access = (cause, fix) => `AgentPier GitHub access: ${cause} — ${fix}`;
const silent = { output: "", problem: null };
const failed = (cause, fix) => ({ output: "", problem: access(cause, fix) });

// gist.<host> serves the gists of <host> and authenticates with its token.
function requestedHosts(value) {
  const direct = nativeHost(`https://${value}`);
  const lower = value.toLowerCase();
  const base = lower.startsWith("gist.") ? nativeHost(`https://${value.slice(5)}`) : null;
  return [direct, base].filter(Boolean);
}

/** The credential for one git request, or the reason there is none. */
export function credentialLookup(input, env = process.env, operation = "get") {
  if (operation !== "get") return silent;
  const fields = parseCredentialRequest(input);
  // git matches credential.<url> case-insensitively but forwards the host as
  // written in the remote URL, so GitHub.com must find the github.com token.
  const raw = fields?.get("host");
  const candidates = raw ? requestedHosts(raw) : [];
  if (!fields || fields.get("protocol") !== "https" || !candidates.length) return silent;
  const folder = env.GH_CONFIG_DIR;
  if (
    typeof folder !== "string" ||
    !path.isAbsolute(folder) ||
    path.basename(path.dirname(folder)) !== "github-sessions" ||
    !validId(path.basename(folder))
  )
    return failed(
      "this process is not an AgentPier session (GH_CONFIG_DIR does not name a session folder)",
      "start or reload the session in AgentPier",
    );
  let selection;
  try {
    selection = readJson(path.join(folder, "selection.json"));
  } catch (error) {
    return error?.code === "ENOENT" && !fs.existsSync(folder)
      ? failed(`the session folder ${folder} is missing`, reload)
      : failed("the session's selection.json cannot be read", reload);
  }
  if (selection?.id !== path.basename(folder) || !Array.isArray(selection.selections))
    return failed("the session's selection.json is invalid", reload);
  const host = candidates.find((candidate) =>
    selection.selections.some(
      (item) => item?.host === candidate && validId(item.credentialId),
    ),
  );
  if (!host)
    return failed(
      `no GitHub profile is selected for ${candidates.at(-1)} in this session`,
      `mark a profile as default for agents in ${settings} or assign one to the project, then ${reload}`,
    );
  let hosts;
  try {
    hosts = readJson(path.join(folder, "hosts.yml"));
  } catch {
    return failed("the session's hosts.yml cannot be read", reload);
  }
  const token = hosts?.[host]?.oauth_token;
  if (
    typeof token !== "string" ||
    !token ||
    token === disabledToken ||
    /[\x00-\x1f\x7f]/.test(token)
  )
    return failed(
      `the GitHub profile for ${host} was removed, moved to another host or has no token`,
      `save a token for ${host} in ${settings}; running sessions pick it up automatically`,
    );
  return { output: `username=x-access-token\npassword=${token}\n\n`, problem: null };
}

export function gitCredential(input, env = process.env, operation = "get") {
  return credentialLookup(input, env, operation).output;
}

export async function runGitCredentialCommand() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > maxCredentialRequestLength) break;
  }
  const { output, problem } = credentialLookup(input, process.env, process.argv[3]);
  if (problem) process.stderr.write(`${problem}\n`);
  process.stdout.write(output);
}
