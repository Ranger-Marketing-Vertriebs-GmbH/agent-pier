import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import pty from "node-pty";
import { stringify as stringifyToml } from "smol-toml";
import {
  browserAttempts,
  codexArgs,
  installedClis,
  isolatedHome,
  keychainAttempts,
  run,
} from "../helpers/cli-contract.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

// Whether each CLI can finish an MCP OAuth login whose callback arrives through
// AgentPier's origin. The results are reported as diagnostics and recorded in
// docs/cli-mcp-qualification.md ("OAuth login brokering"); the assertions only check
// that each CLI started a login at all (it printed an authorization URL). Isolation
// from the owner's configuration, credentials and browser comes from isolatedHome().
const enabled = process.env.AGENTPIER_CLI_MCP_LOGIN_PROBE === "1";
const bins = enabled ? installedClis() : {};
const options = (cli) => ({
  skip: !enabled
    ? "set AGENTPIER_CLI_MCP_LOGIN_PROBE=1 to probe CLI OAuth logins in a temporary HOME"
    : !bins[cli] && `${cli} is not installed`,
  timeout: 300000,
});
// The address a brokered login would return to; never contacted.
const brokered = "https://agentpier.example.test/api/mcp-servers/cli-oauth/callback";

/**
 * Runs a login in a pseudo-terminal. Each new authorization URL goes to `answer`, whose
 * result (a callback URL or null) is typed back followed by Enter.
 */
function drive(bin, args, env, answer, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = pty.spawn(bin, args, {
      env,
      cwd: env.HOME,
      cols: 1000,
      rows: 50,
      name: "xterm",
    });
    let output = "";
    const seen = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve({ output: stripVTControlCharacters(output), urls: seen, timedOut: true });
    }, timeoutMs);
    child.onData(async (data) => {
      output += data;
      for (const [found] of stripVTControlCharacters(output).matchAll(
        /https?:\/\/\S+\/authorize\?\S+/g,
      )) {
        if (seen.includes(found)) continue;
        seen.push(found);
        const reply = await answer(new URL(found)).catch(
          (error) => `error:${error.message}`,
        );
        if (reply) child.write(`${reply}\r`);
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ output: stripVTControlCharacters(output), urls: seen, exitCode });
    });
  });
}

/** What a run tells about brokering, without tokens: redirect target and outcome. */
const summary = (result, status) => ({
  redirectUris: result.urls.map((url) => new URL(url).searchParams.get("redirect_uri")),
  exitCode: result.exitCode ?? null,
  timedOut: !!result.timedOut,
  status,
});

/**
 * The browser's part: approve, then hand back the callback as AgentPier received it. A
 * callback already addressed to AgentPier (the CLI took the custom redirect, perhaps
 * with a path suffix of its own) stays as it is; any other is rewritten onto it.
 */
const viaAgentPier = async (authorize) => {
  const callback = await approve(authorize.href);
  return callback.origin === new URL(brokered).origin
    ? callback.href
    : `${brokered}${callback.search}`;
};
const direct = async (authorize) => (await approve(authorize.href)).href;
/** The browser following the redirect to the CLI's own loopback listener. */
const loopback = async (authorize) => {
  await fetch(await approve(authorize.href));
  return null;
};

test(
  "Codex: login with a callback URL handed back through AgentPier",
  options("codex"),
  async (t) => {
    const isolated = isolatedHome(t);
    const { home, env } = isolated;
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const file = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      stringifyToml({ mcp_servers: { probe: { url: oauth.url } } }),
      { mode: 0o600 },
    );
    const status = async () =>
      JSON.parse(
        (await run(bins.codex, codexArgs("mcp", "list", "--json"), env)).stdout,
      ).find((e) => e.name === "probe")?.auth_status;
    const report = {};
    report.pasted = summary(
      await drive(
        bins.codex,
        codexArgs("mcp", "login", "probe", "--no-browser"),
        env,
        direct,
      ),
      await status(),
    );
    await run(bins.codex, codexArgs("mcp", "logout", "probe"), env);
    report.loggedOut = await status();
    report.brokered = summary(
      await drive(
        bins.codex,
        [
          ...codexArgs("-c", `mcp_oauth_callback_url="${brokered}"`),
          "mcp",
          "login",
          "probe",
          "--no-browser",
        ],
        env,
        viaAgentPier,
      ),
      await status(),
    );
    report.keychain = keychainAttempts(isolated).length;
    report.browser = browserAttempts(isolated).length;
    t.diagnostic(JSON.stringify({ codex: report }));
    assert.ok(report.pasted.redirectUris.length > 0, "Codex printed no login URL");
  },
);

test(
  "Claude Code: login with a callback URL handed back through AgentPier",
  options("claude"),
  async (t) => {
    // isolatedHome() sets CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR inside
    // the temporary HOME, as AgentPier's managed accounts keep Claude Code's
    // credentials apart (provider-environment.js).
    const isolated = isolatedHome(t);
    const { env, claudeConfig } = isolated;
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    fs.writeFileSync(
      path.join(claudeConfig, ".claude.json"),
      JSON.stringify({ mcpServers: { probe: { type: "http", url: oauth.url } } }),
      { mode: 0o600 },
    );
    const status = async () =>
      lineStatus((await run(bins.claude, ["mcp", "get", "probe"], env)).text);
    const report = {};
    try {
      report.pasted = summary(
        await drive(bins.claude, ["mcp", "login", "probe", "--no-browser"], env, direct),
        await status(),
      );
      await run(bins.claude, ["mcp", "logout", "probe"], env);
      report.loggedOut = await status();
      report.brokered = summary(
        await drive(
          bins.claude,
          ["mcp", "login", "probe", "--no-browser"],
          env,
          viaAgentPier,
        ),
        await status(),
      );
    } finally {
      // Before the temporary HOME is removed, so nothing of the login outlives it.
      await run(bins.claude, ["mcp", "logout", "probe"], env);
    }
    report.keychain = keychainAttempts(isolated).length;
    report.browser = browserAttempts(isolated).length;
    t.diagnostic(JSON.stringify({ claude: report }));
    assert.ok(report.pasted.redirectUris.length > 0, "Claude Code printed no login URL");
  },
);
const lineStatus = (text) =>
  text
    .split("\n")
    .find((line) => /Status:/.test(line))
    ?.trim() ?? null;

test(
  "OpenCode: login with a custom redirect and a callback through AgentPier",
  options("opencode"),
  async (t) => {
    const isolated = isolatedHome(t);
    const { home, env } = isolated;
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const file = path.join(home, ".config/opencode/opencode.jsonc");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const write = (oauthConfig) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcp: {
            probe: { type: "remote", url: oauth.url, oauth: oauthConfig, enabled: true },
          },
        }),
        { mode: 0o600 },
      );
    // No browser may open: isolatedHome()'s `open` stub refuses and records the URL.
    const status = async () =>
      lineOf((await run(bins.opencode, ["mcp", "auth", "list"], env)).text);
    write({});
    // OpenCode has no prompt for a pasted callback: it waits on its loopback listener.
    const report = {
      pasted: summary(
        await drive(bins.opencode, ["mcp", "auth", "probe"], env, direct, 15000),
        await status(),
      ),
    };
    // The browser's own path: the callback reaches that listener on this host.
    report.loopback = summary(
      await drive(bins.opencode, ["mcp", "auth", "probe"], env, loopback),
      await status(),
    );
    await run(bins.opencode, ["mcp", "logout", "probe"], env);
    report.loggedOut = await status();
    write({ redirectUri: brokered });
    report.brokered = summary(
      await drive(bins.opencode, ["mcp", "auth", "probe"], env, viaAgentPier),
      await status(),
    );
    report.keychain = keychainAttempts(isolated).length;
    report.browser = browserAttempts(isolated).length;
    t.diagnostic(JSON.stringify({ opencode: report }));
    assert.ok(report.pasted.redirectUris.length > 0, "OpenCode printed no login URL");
  },
);
const lineOf = (text) =>
  text
    .split("\n")
    .find((line) => /\bprobe\b/.test(line))
    ?.trim() ?? null;
