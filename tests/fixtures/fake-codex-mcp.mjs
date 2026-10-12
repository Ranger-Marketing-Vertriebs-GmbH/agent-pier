// A stand-in `codex` for route tests (never the real CLI). It knows two commands the
// way Codex 0.160.1 answers them:
// - `[-c …] mcp list --json`: the servers of $CODEX_HOME/config.toml, `o_auth` for
//   those in $CODEX_HOME/fake-logins.json.
// - `[-c …] mcp login <name> --no-browser`: refuses a server the config lacks, prints
//   an authorization URL whose redirect is `mcp_oauth_callback_url` plus a segment,
//   reads one callback URL from stdin and exits 0 (remembering the login) when it
//   carries its state and a code; 1 otherwise.
// Every call is appended to $FAKE_CODEX_LOG as JSON (arguments and CODEX_HOME).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
if (process.env.FAKE_CODEX_LOG)
  fs.appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({ args, codexHome: process.env.CODEX_HOME ?? null })}\n`,
  );
const overrides = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-c") {
    const [key, ...value] = args[++i].split("=");
    overrides[key] = JSON.parse(value.join("="));
  } else rest.push(args[i]);
}
const config = (() => {
  try {
    return fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return "";
  }
})();
const servers = [...config.matchAll(/^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]/gm)].map(
  (match) => match[2],
);
const loginsFile = path.join(home, "fake-logins.json");
const logins = fs.existsSync(loginsFile)
  ? JSON.parse(fs.readFileSync(loginsFile, "utf8"))
  : [];

if (rest.join(" ") === "mcp list --json") {
  process.stdout.write(
    JSON.stringify(
      servers.map((name) => ({
        name,
        auth_status: logins.includes(name) ? "o_auth" : "not_logged_in",
      })),
    ),
  );
  process.exit(0);
}
if (rest[0] === "mcp" && rest[1] === "login" && rest[3] === "--no-browser") {
  const name = rest[2];
  if (!servers.includes(name) || overrides.mcp_oauth_credentials_store !== "file") {
    process.stderr.write(`Error: No MCP server named '${name}' found.\n`);
    process.exit(1);
  }
  const state = randomBytes(12).toString("hex");
  const redirect = `${overrides.mcp_oauth_callback_url}/SEGMENT12345`;
  process.stdout.write(
    `Authorize the MCP server by opening this URL in your browser:\nhttps://as.example.test/authorize?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(redirect)}\n\nAfter signing in, copy the full URL from your browser's address bar.\n`,
  );
  process.stderr.write("Callback URL (input hidden): ");
  let input = "";
  process.stdin.on("data", (data) => {
    input += data;
    if (!input.includes("\n")) return;
    const url = new URL(input.trim());
    const ok =
      url.href.startsWith(`${redirect}?`) &&
      url.searchParams.get("state") === state &&
      url.searchParams.has("code");
    if (!ok) {
      process.stderr.write("Error: OAuth provider returned an error\n");
      process.exit(1);
    }
    fs.writeFileSync(loginsFile, JSON.stringify([...new Set([...logins, name])]));
    process.stdout.write(`Successfully logged in to MCP server '${name}'.\n`);
    process.exit(0);
  });
  process.stdin.on("end", () => process.exit(1));
} else process.exit(2);
