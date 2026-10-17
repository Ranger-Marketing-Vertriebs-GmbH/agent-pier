import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubTokenMonitor } from "../../server/features/repositories/github-token-monitor.js";
import {
  githubApiBase,
  tokenExpiry,
} from "../../server/features/repositories/github-token-check.js";

const day = 24 * 60 * 60 * 1000;
const format = (time) =>
  new Date(time)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");

// A fake GitHub API: each token decides the answer of GET /user and repository probes.
async function fakeGithub(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    requests.push({ path: req.url, token });
    const send = (status, headers, body = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v3/user") {
      if (token === "ghp_classic")
        return send(
          200,
          {
            "x-oauth-scopes": "repo, read:org",
            "github-authentication-token-expiration": format(Date.now() + 30 * day),
          },
          { login: "octo" },
        );
      if (token === "github_pat_soon")
        return send(
          200,
          { "github-authentication-token-expiration": format(Date.now() + 2 * day) },
          { login: "octo" },
        );
      if (token === "ghp_expired")
        return send(401, {
          "github-authentication-token-expiration": format(Date.now() - day),
        });
      if (token === "ghp_limited") return send(403, { "x-ratelimit-remaining": "0" });
      return send(401, {}, { message: "Bad credentials" });
    }
    if (req.url === "/api/v3/repos/acme/app")
      return send(403, {
        "x-github-sso":
          "required; url=https://ghe.test/orgs/acme/sso?authorization_request=fixture",
      });
    if (req.url === "/api/v3/repos/open/tool") return send(200, {}, { id: 1 });
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, options) =>
    fetch(String(url).replace("https://ghe.test", origin), options);
  return { requests, fetchImpl };
}

function store(t, fetchImpl) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-gtc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RepositoryStore({ dataDir: path.join(root, "data"), home: root, fetchImpl });
}

test("API bases and expiry headers follow GitHub's formats", () => {
  assert.equal(githubApiBase("https://github.com"), "https://api.github.com");
  assert.equal(githubApiBase("https://acme.ghe.com"), "https://api.acme.ghe.com");
  assert.equal(
    githubApiBase("https://git.example.test"),
    "https://git.example.test/api/v3",
  );
  assert.equal(tokenExpiry("2026-11-01 12:00:00 UTC"), "2026-11-01T12:00:00.000Z");
  assert.equal(tokenExpiry("2026-11-01 12:00:00 +0100"), "2026-11-01T11:00:00.000Z");
  assert.equal(tokenExpiry("soon"), null);
});

test("a check reports login, scopes, expiry, token type and SAML SSO without the token", async (t) => {
  const { requests, fetchImpl } = await fakeGithub(t);
  const repositories = store(t, fetchImpl);
  const classic = repositories.createCredential({
    name: "Work",
    host: "https://ghe.test",
    token: "ghp_classic",
  });
  repositories.projects = [
    { path: "/x/app", url: "https://ghe.test/acme/app.git", credentialId: classic.id },
    { path: "/x/tool", url: "https://ghe.test/open/tool", credentialId: classic.id },
    { path: "/x/other", url: "https://other.test/acme/app", credentialId: classic.id },
  ];
  const checked = await repositories.checkCredential(classic.id);
  assert.equal(checked.tokenCheck.state, "valid");
  assert.equal(checked.tokenCheck.login, "octo");
  assert.equal(checked.tokenCheck.tokenType, "classic");
  assert.deepEqual(checked.tokenCheck.scopes, ["repo", "read:org"]);
  assert.ok(Date.parse(checked.tokenCheck.expiresAt) > Date.now() + 29 * day);
  assert.deepEqual(checked.tokenCheck.sso, [
    {
      organization: "acme",
      url: "https://ghe.test/orgs/acme/sso?authorization_request=fixture",
    },
  ]);
  // Only paths built from the host's own projects received the token.
  assert.deepEqual(
    requests.map((item) => item.path),
    ["/api/v3/user", "/api/v3/repos/acme/app", "/api/v3/repos/open/tool"],
  );
  assert.equal(JSON.stringify(repositories.listCredentials()).includes("ghp_"), false);
  // The stored result belongs to the old token; a new token clears it.
  repositories.updateCredential(classic.id, { name: "Work", token: "ghp_other" });
  assert.equal(repositories.credential(classic.id).tokenCheck, undefined);
});

test("rejected, expired, expiring and rate-limited tokens are told apart", async (t) => {
  const { fetchImpl } = await fakeGithub(t);
  const repositories = store(t, fetchImpl);
  const state = async (token) => {
    const item = repositories.createCredential({
      name: token,
      host: "https://ghe.test",
      token,
    });
    const { tokenCheck } = await repositories.checkCredential(item.id);
    assert.equal(JSON.stringify(tokenCheck).includes(token), false);
    return [tokenCheck.state, tokenCheck.error, tokenCheck.tokenType];
  };
  assert.deepEqual(await state("ghp_revoked"), ["invalid", "unauthorized", "classic"]);
  assert.deepEqual(await state("ghp_expired"), ["expired", "unauthorized", "classic"]);
  assert.deepEqual(await state("github_pat_soon"), [
    "expiring",
    undefined,
    "fine-grained",
  ]);
  assert.deepEqual(await state("ghp_limited"), ["error", "rateLimited", "classic"]);
  const unreachable = store(t, () => Promise.reject(new Error("offline")));
  const item = unreachable.createCredential({
    name: "Offline",
    host: "https://ghe.test",
    token: "ghp_classic",
  });
  assert.equal(
    (await unreachable.checkCredential(item.id)).tokenCheck.error,
    "unreachable",
  );
});

test("the daily check marks bad tokens, notifies once per change and skips recent checks", async (t) => {
  const { requests, fetchImpl } = await fakeGithub(t);
  const repositories = store(t, fetchImpl);
  const good = repositories.createCredential({
    name: "Good",
    host: "https://ghe.test",
    token: "ghp_classic",
  });
  const bad = repositories.createCredential({
    name: "Bad",
    host: "https://ghe.test",
    token: "ghp_revoked",
  });
  const notices = [];
  let now = Date.now();
  const monitor = new GithubTokenMonitor({
    repositories,
    notifications: { notify: async (input) => notices.push(input) },
    now: () => now,
  });
  t.after(() => monitor.close());
  await monitor.run();
  const states = () =>
    Object.fromEntries(
      repositories.listCredentials().map((item) => [item.id, item.tokenCheck?.state]),
    );
  assert.deepEqual(states(), { [good.id]: "valid", [bad.id]: "invalid" });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "github-token");
  assert.match(notices[0].eventId, /^[a-f0-9]{64}$/);
  const calls = requests.length;
  await monitor.run();
  assert.equal(requests.length, calls, "a check younger than a day is not repeated");
  now += 2 * day;
  await monitor.run();
  assert.equal(notices.length, 1, "an unchanged bad state is not announced again");
});

test("closing the monitor aborts a token check that is still waiting for GitHub", async (t) => {
  let aborted = false;
  const repositories = store(
    t,
    (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      ),
  );
  repositories.createCredential({
    name: "Slow",
    host: "https://ghe.test",
    token: "ghp_x",
  });
  const monitor = new GithubTokenMonitor({ repositories, notifications: null });
  const running = monitor.run();
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await monitor.close();
  assert.ok(Date.now() - started < 2000, "close must not wait for GitHub");
  assert.equal(aborted, true);
  await running;
});
