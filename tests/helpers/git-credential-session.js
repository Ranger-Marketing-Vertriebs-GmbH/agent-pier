import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A minimal session folder as GithubCredentials.prepare writes it, with a fake token. */
export function credentialSession(
  t,
  { host = "github.com", token = "fixture-token" } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-gc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "github-sessions", "session-1");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(folder, "selection.json"),
    JSON.stringify({ id: "session-1", selections: [{ host, credentialId: "cred-1" }] }),
  );
  fs.writeFileSync(
    path.join(folder, "hosts.yml"),
    JSON.stringify({ [host]: { oauth_token: token, git_protocol: "https" } }),
  );
  return { env: { GH_CONFIG_DIR: folder }, token };
}

export const gitCapabilityLines = [
  "capability[]=authtype",
  "capability[]=state",
  'wwwauth[]=Basic realm="GitHub"',
  'wwwauth[]=Bearer realm="GitHub"',
];
