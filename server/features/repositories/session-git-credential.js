// The git credential helper of agent sessions, started through the stable
// server/github-credentials.js entry point. git runs it as a subprocess on every
// HTTPS authentication, so its import graph stays limited to Node built-ins and
// small local modules; it never loads the server or npm packages.
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
// after a configured token has been revoked. It accepts only canonical HTTPS hosts.
// When it prints nothing, the helper that follows it in the session's git
// configuration tells git to quit instead of prompting inside the agent's pane.
export function gitCredential(input, env = process.env, operation = "get") {
  if (operation !== "get") return "";
  const fields = parseCredentialRequest(input);
  // git matches credential.<url> case-insensitively but forwards the host as
  // written in the remote URL, so GitHub.com must find the github.com token.
  const host = fields?.get("host") && nativeHost(`https://${fields.get("host")}`);
  if (!fields || fields.get("protocol") !== "https" || !host) return "";
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
        (item) => item?.host === host && validId(item.credentialId),
      )
    )
      return "";
    const hosts = readJson(path.join(folder, "hosts.yml"));
    const token = hosts[host]?.oauth_token;
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
    if (input.length > maxCredentialRequestLength) break;
  }
  process.stdout.write(gitCredential(input, process.env, process.argv[3]));
}
