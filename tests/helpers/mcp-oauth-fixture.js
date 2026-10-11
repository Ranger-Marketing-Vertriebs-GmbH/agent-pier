import {
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { McpOAuthLogins } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { mcpApplyFixture } from "./mcp-apply-fixture.js";

export const redirect = "http://127.0.0.1:4380/api/mcp-servers/oauth/callback";
export const local = "http://127.0.0.1:4380";

/**
 * A CLI stand-in that records every call in order (`logout` with the URL of the
 * one-server config it was given) and answers from `script`.
 */
export function stubCli(script = {}) {
  const calls = [];
  let n = 0;
  const answer = async (method, args, fallback, input = args) => {
    calls.push([method, ...args]);
    const value = script[method];
    if (typeof value === "function") return value(...input);
    if (value instanceof Error) throw value;
    return value ?? fallback();
  };
  return {
    calls,
    startLogin: (name) =>
      answer("startLogin", [name], () => {
        const state = `state-${++n}`;
        return { authorizationUrl: `https://as.example/authorize?state=${state}`, state };
      }),
    completeLogin: (name, code) => answer("completeLogin", [name, code], () => undefined),
    logout: (name, options = {}) =>
      answer("logout", [name], () => undefined, [name, options]),
    status: () => answer("status", [], () => ({})),
  };
}

/**
 * McpChanges on a fake Gateway with an OAuth server `docs` bound to one agent and
 * compiled by the running Gateway; the login service uses `stubCli(script)`.
 */
export function oauthFixture(t, script, options = {}) {
  let clock = 1_000_000;
  let currentRedirect = redirect;
  const f = mcpApplyFixture(t, { redirectUrl: () => currentRedirect });
  const cli = stubCli(script);
  const warnings = [];
  const oauth = new McpOAuthLogins({
    cli,
    servers: f.servers,
    runtime: f.runtime,
    admit: (operation) => f.service.admit(operation),
    redirectUrl: () => currentRedirect,
    remoteUrl: () => options.remoteUrl ?? null,
    reapply: () => f.changes.apply(),
    now: () => clock,
    warn: (text) => warnings.push(text),
  });
  f.changes.oauth = oauth;
  const home = f.agent("Home");
  const docs = f.servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com/v1",
    auth: "oauth",
  });
  f.servers.setBindings("agent", home.id, [docs.id]);
  // The running Gateway compiled the store as it is now.
  const compile = () => {
    f.runtime.mcp = mcpStartSnapshot(
      {
        profiles: f.store.listAssistants(),
        mcp: readMcpInputs(f.servers, { redirectUrl: currentRedirect }),
      },
      () => {},
    );
  };
  compile();
  return {
    ...f,
    cli,
    oauth,
    docs,
    home,
    warnings,
    compile,
    setRedirect: (value) => (currentRedirect = value),
    advance: (ms) => (clock += ms),
    logouts: () => cli.calls.filter(([method]) => method === "logout"),
    nudges: () =>
      f.gateway.patches.filter((p) => "sessionIdleTtlMs" in (p.patch.mcp || {})),
  };
}

export const refusal = (code, status) => (error) => {
  if (error.code !== code || error.status !== status)
    throw new Error(`expected ${code}/${status}, got ${error.code}/${error.status}`);
  return true;
};
