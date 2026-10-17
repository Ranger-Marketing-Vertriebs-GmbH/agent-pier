import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  credentialLookup,
  gitCredential,
} from "../../server/features/repositories/session-git-credential.js";
import { credentialSession } from "../helpers/git-credential-session.js";

const request = (host) => `protocol=https\nhost=${host}\n\n`;
const prefix = /^AgentPier GitHub access: .+ — .+$/;

test("gist.<host> receives the token of the host's selected profile", (t) => {
  const { env, token } = credentialSession(t);
  for (const host of ["gist.github.com", "Gist.GitHub.com"])
    assert.equal(
      gitCredential(request(host), env),
      `username=x-access-token\npassword=${token}\n\n`,
    );
  const enterprise = credentialSession(t, { host: "git.example.test", token: "ghe" });
  assert.equal(
    gitCredential(request("gist.git.example.test"), enterprise.env),
    "username=x-access-token\npassword=ghe\n\n",
  );
  // Only the gist subdomain maps; other subdomains stay unknown.
  assert.equal(gitCredential(request("api.github.com"), env), "");
  assert.equal(gitCredential(request("gist.unknown.test"), env), "");
});

test("each helper failure names its cause and the fix", (t) => {
  const { env } = credentialSession(t);
  const folder = env.GH_CONFIG_DIR;
  const problem = (input, environment) => {
    const result = credentialLookup(input, environment);
    assert.equal(result.output, "");
    assert.match(result.problem, prefix);
    return result.problem;
  };
  assert.match(problem(request("github.com"), {}), /not an AgentPier session/);
  assert.match(
    problem(request("github.com"), { GH_CONFIG_DIR: "/tmp/elsewhere" }),
    /not an AgentPier session/,
  );
  assert.match(
    problem(request("example.test"), env),
    /no GitHub profile is selected for example\.test.*Settings → Access → GitHub/,
  );
  fs.writeFileSync(path.join(folder, "hosts.yml"), "{broken");
  assert.match(problem(request("github.com"), env), /hosts\.yml.*reload the session/);
  fs.writeFileSync(
    path.join(folder, "hosts.yml"),
    JSON.stringify({
      "github.com": { oauth_token: "agentpier-disabled-no-token" },
    }),
  );
  assert.match(
    problem(request("github.com"), env),
    /profile for github\.com was removed.*Settings → Access → GitHub/,
  );
  fs.rmSync(folder, { recursive: true });
  assert.match(problem(request("github.com"), env), /session folder.*is missing/);
});

test("requests git never routes to the helper stay silent", (t) => {
  const { env, token } = credentialSession(t);
  for (const [input, operation] of [
    [request("github.com"), "store"],
    [request("github.com"), "erase"],
    ["protocol=http\nhost=github.com\n\n", "get"],
    ["protocol=https\nhost=github.com\nhost=evil.test\n\n", "get"],
  ])
    assert.deepEqual(credentialLookup(input, env, operation), {
      output: "",
      problem: null,
    });
  // A successful lookup never carries a message, and a message never the token.
  assert.deepEqual(credentialLookup(request("github.com"), env), {
    output: `username=x-access-token\npassword=${token}\n\n`,
    problem: null,
  });
});
