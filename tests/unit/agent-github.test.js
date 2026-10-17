import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  githubAccessInput,
  githubServerArgs,
  githubServerEnv,
  githubServerName,
  memberGithub,
  missingScopes,
} from "../../server/features/assistants/agent-github.js";
import {
  assertWithinLead,
  grantInput,
  grantedKeys,
  memberInheritance,
  mergeGrants,
  removeGrants,
} from "../../server/features/assistants/member-grants.js";
import {
  mcpSections,
  mcpSnapshot,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";
import { execShellScript } from "../../server/features/assistants/exec-shell.js";
import {
  githubChoice,
  githubScopeGap,
} from "../../web/features/assistants/settings/agent-github-fields.js";

test("each level runs the GitHub MCP server with its own toolsets", () => {
  assert.deepEqual(githubServerArgs("read"), [
    "stdio",
    "--toolsets",
    "repos,issues,pull_requests,actions",
    "--read-only",
  ]);
  const write = githubServerArgs("write");
  assert.ok(!write.includes("--read-only"));
  assert.deepEqual(write.slice(0, 3), [
    "stdio",
    "--toolsets",
    "repos,issues,pull_requests,actions",
  ]);
  // Actions stay readable (CI status) but never triggered; no repository is created,
  // forked or deleted.
  assert.deepEqual(write.slice(3), [
    "--exclude-tools",
    "actions_run_trigger,create_repository,fork_repository,delete_repository",
  ]);
  assert.throws(() => githubServerArgs("admin"));
});

test("server names are stable tool prefixes per profile and level", () => {
  const read = githubServerName("profile-1", "read");
  assert.equal(read, githubServerName("profile-1", "read"));
  assert.notEqual(read, githubServerName("profile-1", "write"));
  assert.notEqual(read, githubServerName("profile-2", "read"));
  for (const name of [read, githubServerName("x", "write")])
    assert.match(name, /^github_r[ow]_[0-9a-f]{8}$/);
});

test("the token goes into the server's environment, the host only for Enterprise", () => {
  assert.deepEqual(githubServerEnv("https://github.com", "ghp_secret"), {
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret",
  });
  assert.deepEqual(githubServerEnv("https://ghe.example.com", "t"), {
    GITHUB_PERSONAL_ACCESS_TOKEN: "t",
    GITHUB_HOST: "https://ghe.example.com",
  });
});

test("an access names a known profile and a level", () => {
  const credentials = [{ id: "p1" }];
  assert.equal(githubAccessInput(null, credentials), null);
  assert.deepEqual(
    githubAccessInput({ credentialId: "p1", level: "write" }, credentials),
    {
      credentialId: "p1",
      level: "write",
    },
  );
  for (const bad of [
    {},
    { credentialId: "p1" },
    { credentialId: "p1", level: "admin" },
    { credentialId: "p1", level: "read", token: "x" },
    [],
    "read",
  ])
    assert.throws(() => githubAccessInput(bad, credentials), { status: 400 });
  assert.throws(
    () => githubAccessInput({ credentialId: "gone", level: "read" }, credentials),
    {
      status: 409,
      key: "githubProfileUnavailable",
    },
  );
});

test("a member's GitHub access never exceeds its lead's live level", () => {
  const lead = {
    id: "lead",
    capabilities: {},
    shell: "off",
  };
  assert.deepEqual(grantInput({ github: "read" }), { github: "read" });
  assert.deepEqual(grantInput({ github: "none" }), {});
  assert.throws(() => grantInput({ github: "admin" }), { status: 400 });
  assert.deepEqual(memberGithub("write", { credentialId: "p", level: "read" }), {
    credentialId: "p",
    level: "read",
  });
  assert.deepEqual(memberGithub("read", { credentialId: "p", level: "write" }), {
    credentialId: "p",
    level: "read",
  });
  assert.equal(memberGithub("read", null), null);
  assert.equal(memberGithub(undefined, { credentialId: "p", level: "write" }), null);
  // The lead's ceiling: nothing without its own access, never above its level.
  assert.throws(() => assertWithinLead(lead, { github: "read" }, {}), {
    key: "teamGrantNotHeld",
  });
  assert.throws(
    () =>
      assertWithinLead(
        lead,
        { github: "write" },
        {
          github: { credentialId: "p", level: "read" },
        },
      ),
    { key: "teamGrantNotHeld" },
  );
  assertWithinLead(
    lead,
    { github: "read" },
    {
      github: { credentialId: "p", level: "write" },
    },
  );
  // Resolved live: the lead's current access decides, an ineligible lead grants none.
  const held = { credentialId: "p", level: "write" };
  assert.deepEqual(
    memberInheritance(lead, { github: "write" }, false, {}, held).github,
    held,
  );
  assert.equal(
    memberInheritance(lead, { github: "write" }, false, {}, null).github,
    null,
  );
  assert.equal(
    memberInheritance({ ...lead, archivedAt: "x" }, { github: "read" }, false, {}, held)
      .github,
    null,
  );
  assert.deepEqual(mergeGrants({ github: "read" }, { github: "write" }), {
    github: "write",
  });
  assert.deepEqual(mergeGrants({ github: "write" }, { github: "read" }), {
    github: "write",
  });
  assert.deepEqual(removeGrants({ github: "write", memory: true }, { github: "read" }), {
    memory: true,
  });
  assert.deepEqual(grantedKeys({ github: "read" }), ["github"]);
});

test("compiled servers carry the token only in their environment", () => {
  const token = "ghp_never_in_the_model";
  const server = {
    id: "github:p:read",
    name: githubServerName("p", "read"),
    transport: "stdio",
    command: "/opt/clis/github-mcp-server",
    args: githubServerArgs("read"),
  };
  const sections = mcpSections({
    profiles: [{ id: "a1", runtimeAgentId: "agent-a1" }],
    servers: [server],
    bindings: { a1: [server.id] },
    secrets: {
      [server.id]: { headers: {}, env: githubServerEnv("https://github.com", token) },
    },
  });
  const compiled = sections.servers[server.name];
  assert.equal(compiled.env.GITHUB_PERSONAL_ACCESS_TOKEN, token);
  assert.doesNotMatch(JSON.stringify(compiled.args), new RegExp(token));
  assert.deepEqual(sections.agentTools, { "agent-a1": [`${server.name}__*`] });
  // What AgentPier keeps about a start and the agent's instructions never hold it.
  assert.doesNotMatch(JSON.stringify(mcpSnapshot(sections)), new RegExp(token));
  const instructions = assistantBootstrap(
    { id: "a1", instructions: "" },
    {},
    {
      github: {
        profile: "Work",
        host: "https://github.com",
        level: "read",
        server: server.name,
        shell: true,
      },
    },
  );
  assert.match(instructions, /## GitHub/);
  assert.match(instructions, new RegExp(`${server.name}__\\*`));
  assert.match(instructions, /read-only/);
  assert.match(instructions, /gh and git use the same profile/);
  assert.doesNotMatch(instructions, new RegExp(token));
});

test("missing scopes are named only when the token's scopes are known", () => {
  assert.equal(missingScopes(null, "read"), null);
  assert.equal(missingScopes([], "read"), null);
  assert.deepEqual(missingScopes(["read:org"], "write"), ["repo"]);
  assert.deepEqual(missingScopes(["repo", "workflow"], "write"), []);
  assert.deepEqual(githubScopeGap({ scopes: ["gist"] }, "read"), ["repo"]);
  assert.equal(githubScopeGap({}, "read"), null);
});

test("the Work tab prefills the default profile for agents", () => {
  const profiles = [
    { id: "ghe", host: "https://ghe.example.com", agentDefault: true },
    { id: "other", host: "https://github.com", agentDefault: false },
    { id: "main", host: "https://github.com", agentDefault: true },
  ];
  assert.deepEqual(githubChoice(null, profiles), {
    level: null,
    credentialId: "main",
    profile: profiles[2],
    missing: false,
  });
  assert.equal(
    githubChoice({ credentialId: "other", level: "read" }, profiles).profile,
    profiles[1],
  );
  assert.equal(
    githubChoice({ credentialId: "gone", level: "read" }, profiles).missing,
    true,
  );
});

test("the exec wrapper sources only an agent's GitHub folder on its PATH", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-github-sh-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const folder = path.join(dir, "github-sessions", "agent-a1");
  fs.mkdirSync(path.join(folder, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "shell-env.sh"),
    `export GH_CONFIG_DIR='${folder}'\nunset GH_TOKEN\n`,
  );
  const wrapper = path.join(dir, "sh");
  fs.writeFileSync(wrapper, execShellScript(home), { mode: 0o700 });
  const run = (PATH) =>
    execFileSync(
      wrapper,
      ["-c", 'printf "%s|%s|%s" "$GH_CONFIG_DIR" "$GH_TOKEN" "$HOME"'],
      {
        env: { PATH, GH_TOKEN: "owner-token" },
        encoding: "utf8",
      },
    );
  assert.equal(run(`${path.join(folder, "bin")}:/usr/bin:/bin`), `${folder}||${home}`);
  // Without the folder on PATH nothing changes: the owner's environment stays.
  assert.equal(run("/usr/bin:/bin"), `|owner-token|${home}`);
  // A folder without its environment file is skipped.
  fs.rmSync(path.join(folder, "shell-env.sh"));
  assert.equal(run(`${path.join(folder, "bin")}:/usr/bin:/bin`), `|owner-token|${home}`);
});
