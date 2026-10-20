import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import {
  GithubCredentials,
  gitCredential,
} from "../../server/features/repositories/github-credentials.js";
import {
  mcpSections,
  mcpSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { githubServerName } from "../../server/features/assistants/agent-github.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { execShellScript } from "../../server/features/assistants/exec-shell.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";

const token = "ghp_agent_token_never_shown";
const rotated = "ghp_rotated_token_never_shown";

// An agent, two token profiles, the session credentials and an installed server.
async function setup(t) {
  const f = await workflowFixture(t);
  // The real path, as AgentPier's data directory is: the session files refuse links.
  const repositories = new RepositoryStore({ dataDir: fs.realpathSync(f.dataDir) });
  const work = repositories.createCredential({
    name: "Work",
    host: "https://github.com",
    token,
  });
  const ghe = repositories.createCredential({
    name: "Enterprise",
    host: "https://ghe.example.com",
    token: "ghe-token",
  });
  const github = new GithubCredentials({ dataDir: f.dataDir, repositories });
  const executable = path.join(f.dataDir, "clis", "github-mcp-server");
  let ensured = 0;
  const githubMcp = {
    executable: () => executable,
    state: () => ({ available: true, installed: true, version: "2.0.2" }),
    ensure: () => ensured++,
  };
  Object.assign(f.services, { repositories, github, githubMcp });
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const save = (value) =>
    f.workflows.access.save(
      f.id,
      { ...f.policy, github: value },
      f.workflows.access.get(f.id).revision,
    );
  const setShell = (shell) => {
    const raw = f.store.storedAssistant(f.id);
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify({ ...raw, shell }), f.id);
  };
  const compiled = () => {
    const profiles = f.store.listAssistants();
    const inputs = readMcpInputs(null, {
      extra: (taken) => f.workflows.github.mcpInputs(profiles, taken),
    });
    return mcpSections({ profiles, ...inputs });
  };
  return {
    ...f,
    repositories,
    github,
    githubMcp,
    work,
    ghe,
    audits,
    save,
    setShell,
    compiled,
    ensured: () => ensured,
  };
}

test("an agent's access compiles its server with the token in env only", async (t) => {
  const f = await setup(t);
  assert.equal(f.compiled().servers && Object.keys(f.compiled().servers).length, 0);
  const saved = f.save({ credentialId: f.work.id, level: "read" });
  assert.deepEqual(saved.github, { credentialId: f.work.id, level: "read" });
  const sections = f.compiled();
  const name = githubServerName(f.work.id, "read");
  const agent = f.store.getAssistant(f.id);
  assert.deepEqual(Object.keys(sections.servers), [name]);
  assert.deepEqual(sections.servers[name], {
    command: f.githubMcp.executable(),
    args: ["stdio", "--toolsets", "repos,issues,pull_requests,actions", "--read-only"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
  });
  assert.deepEqual(sections.agentTools, { [agent.runtimeAgentId]: [`${name}__*`] });
  assert.doesNotMatch(JSON.stringify(mcpSnapshot(sections)), new RegExp(token));
  // The Work tab catalog and the stored access name the profile, never its token.
  const catalog = f.workflows.github.catalog();
  assert.deepEqual(
    catalog.map((p) => p.name),
    ["Work", "Enterprise"],
  );
  assert.doesNotMatch(
    JSON.stringify([catalog, f.workflows.access.get(f.id)]),
    /token_never/,
  );
  // Audited with the profile id and levels.
  const audit = f.audits.find((e) => e.details?.kind === "github-access");
  assert.deepEqual(audit.details, {
    kind: "github-access",
    githubFrom: "none",
    githubTo: "read",
    credentialId: f.work.id,
  });
  // Its instructions name the tools; with GitHub Enterprise the host goes to env.
  const described = f.workflows.github.describe(agent);
  assert.deepEqual(described, {
    profile: "Work",
    host: "https://github.com",
    level: "read",
    server: name,
    shell: false,
  });
  assert.doesNotMatch(
    assistantBootstrap(agent, {}, { github: described }),
    new RegExp(token),
  );
  f.save({ credentialId: f.ghe.id, level: "write" });
  const enterprise = f.compiled().servers[githubServerName(f.ghe.id, "write")];
  assert.deepEqual(enterprise.env, {
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghe-token",
    GITHUB_HOST: "https://ghe.example.com",
  });
  assert.ok(!enterprise.args.includes("--read-only"));
  assert.ok(!enterprise.args.includes("--exclude-tools"));
  // Removing the access removes the server; an unknown profile is refused.
  f.save(null);
  assert.deepEqual(f.compiled().servers, {});
  assert.throws(() => f.save({ credentialId: "gone", level: "read" }), {
    key: "githubProfileUnavailable",
  });
});

test("a rotated or deleted profile updates the agents using it", async (t) => {
  const f = await setup(t);
  f.save({ credentialId: f.work.id, level: "write" });
  const name = githubServerName(f.work.id, "write");
  const before = mcpSnapshot(f.compiled()).signature;
  f.repositories.updateCredential(f.work.id, { name: "Work", token: rotated });
  const after = f.compiled();
  assert.equal(after.servers[name].env.GITHUB_PERSONAL_ACCESS_TOKEN, rotated);
  // The fingerprint a live apply compares changes, so the Gateway is patched.
  assert.notEqual(mcpSnapshot(after).signature, before);
  f.repositories.removeCredential(f.work.id);
  assert.deepEqual(f.compiled().servers, {});
  assert.equal(f.workflows.github.describe(f.store.getAssistant(f.id)), null);
  // The stored access stays, refers to nothing, and saving other settings works.
  assert.equal(f.workflows.access.get(f.id).github.credentialId, f.work.id);
  f.workflows.access.save(f.id, f.policy, f.workflows.access.get(f.id).revision);
});

test("with shell, gh and git use the agent's profile, never the owner's", async (t) => {
  const f = await setup(t);
  const agent = () => f.store.getAssistant(f.id);
  f.save({ credentialId: f.work.id, level: "read" });
  // Without shell the agent has no GitHub folder on its PATH.
  assert.deepEqual(f.workflows.github.shellPath(agent()), []);
  f.setShell("full");
  const [marker] = f.workflows.github.shellPath(agent());
  const folder = path.dirname(marker);
  assert.equal(path.basename(folder), `agent-${f.id}`);
  const env = fs.readFileSync(path.join(folder, "shell-env.sh"), "utf8");
  assert.doesNotMatch(env, new RegExp(token));
  assert.match(env, /credential\.https:\/\/github\.com\.helper/);
  // The wrapper finds the folder on PATH; the shell sees no token, gh its hosts.yml.
  const home = path.join(f.dataDir, "home");
  fs.mkdirSync(home);
  const wrapper = path.join(f.dataDir, "sh");
  fs.writeFileSync(wrapper, execShellScript(home), { mode: 0o700 });
  const shellEnv = execFileSync(wrapper, ["-c", "env"], {
    env: { PATH: `${marker}:/usr/bin:/bin`, GH_TOKEN: "owner-login" },
    encoding: "utf8",
  });
  assert.doesNotMatch(shellEnv, new RegExp(token));
  assert.doesNotMatch(shellEnv, /owner-login/);
  assert.match(shellEnv, new RegExp(`GH_CONFIG_DIR=${folder}`));
  // github.com and gist.github.com, each: cleared, AgentPier's helper, quit.
  assert.match(shellEnv, /GIT_CONFIG_COUNT=6/);
  assert.match(
    shellEnv,
    /GIT_CONFIG_KEY_4=credential\.https:\/\/gist\.github\.com\.helper/,
  );
  const vars = Object.fromEntries(
    shellEnv
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  // The helper names the agent folder itself, like an owner shell's session.
  assert.ok(
    vars.GIT_CONFIG_VALUE_1.endsWith(
      `github-credentials.js' --git-credential --session '${folder}'`,
    ),
  );
  // AgentPier's helper answers git with the profile's token for that host only.
  const answer = (environment) =>
    gitCredential("protocol=https\nhost=github.com\n\n", environment);
  assert.equal(
    answer({ GH_CONFIG_DIR: folder }),
    `username=x-access-token\npassword=${token}\n\n`,
  );
  // The helper as git starts it from the agent's shell: the folder from --session.
  const helper = execFileSync(
    process.execPath,
    [
      path.resolve("server/github-credentials.js"),
      "--git-credential",
      "--session",
      folder,
      "get",
    ],
    { input: "protocol=https\nhost=gist.github.com\n\n", env: {}, encoding: "utf8" },
  );
  assert.equal(helper, `username=x-access-token\npassword=${token}\n\n`);
  // Rotation reaches hosts.yml through the session sync, deletion revokes it.
  f.repositories.updateCredential(f.work.id, { name: "Work", token: rotated });
  await f.github.sync();
  assert.match(answer({ GH_CONFIG_DIR: folder }), new RegExp(rotated));
  f.repositories.removeCredential(f.work.id);
  await f.github.sync();
  assert.equal(answer({ GH_CONFIG_DIR: folder }), "");
  // Without access the folder goes at the next start's sweep.
  f.save(null);
  assert.deepEqual(f.workflows.github.shellPaths(f.store.listAssistants()), {});
  assert.equal(fs.existsSync(folder), false);
});

test("a refresh installs the server on first use and re-applies the agents", async (t) => {
  const f = await setup(t);
  const applied = [];
  let patched = 0;
  f.assistants.mcp = { applySaved: async () => patched++ };
  f.assistants.runtime = { client: { ready: true } };
  f.assistants.config = { apply: async (id) => applied.push(id) };
  await f.workflows.github.refresh();
  assert.equal(f.ensured(), 0);
  assert.equal(patched, 1);
  f.save({ credentialId: f.work.id, level: "read" });
  assert.equal(f.workflows.github.changed(), true);
  await f.workflows.github.refresh();
  assert.equal(f.ensured(), 1);
  assert.deepEqual(applied, [f.id]);
  assert.equal(f.workflows.github.changed(), false);
  // Losing access re-applies the agent once more, so its instructions drop GitHub.
  f.save(null);
  await f.workflows.github.refresh();
  assert.deepEqual(applied, [f.id, f.id]);
});

// A lead with GitHub access and one running task member.
async function team(t, memberGrants) {
  const f = await setup(t);
  f.save({ credentialId: f.work.id, level: "write" });
  const teams = new TeamStore({
    store: f.store,
    github: (id) => f.workflows.github.held(id),
  });
  f.assistants.teams = { store: teams };
  const parentRequest = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team that reviews the pull requests",
  });
  teams.recordContext(parentRequest.id, { kind: "owner", teamAllowed: true });
  const parentAttempt = f.assistants.ledger.recordAttempt(parentRequest.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: parentAttempt.id,
    objective: "Review pull requests",
    members: [
      { name: "Reviewer", role: "Review", assignment: "Review", grants: memberGrants },
    ],
  });
  f.assistants.ledger.transition(parentAttempt.id, "completed");
  teams.reserve(proposed.id);
  const member = teams.members(proposed.id)[0];
  return { ...f, teams, member, agent: () => f.store.getAssistant(member.assistantId) };
}

test("a lead passes GitHub to a member within its own live level", async (t) => {
  const f = await team(t, { github: "read" });
  const name = githubServerName(f.work.id, "read");
  assert.deepEqual(f.workflows.github.forAgent(f.agent()).level, "read");
  assert.ok(f.compiled().agentTools[f.agent().runtimeAgentId].includes(`${name}__*`));
  // A later grant raises it to the lead's level; the lead lowering its own caps it.
  f.teams.write(f.teams.member(f.member.id), { grants: { github: "write" } });
  assert.equal(f.workflows.github.forAgent(f.agent()).level, "write");
  f.save({ credentialId: f.work.id, level: "read" });
  assert.equal(f.workflows.github.forAgent(f.agent()).level, "read");
  f.save(null);
  assert.equal(f.workflows.github.forAgent(f.agent()), null);
  assert.equal(f.compiled().agentTools[f.agent().runtimeAgentId], undefined);
});

test("a temporary member cannot hold GitHub access of its own", async (t) => {
  const f = await team(t, { github: "read" });
  assert.throws(
    () =>
      f.workflows.access.save(
        f.member.assistantId,
        { ...f.policy, github: { credentialId: f.work.id, level: "read" } },
        0,
      ),
    { status: 409, key: "githubFromLead" },
  );
});

test("a GitHub Enterprise profile names its host for gh in the agent's shell", async (t) => {
  const f = await setup(t);
  f.setShell("full");
  f.save({ credentialId: f.ghe.id, level: "read" });
  const [marker] = f.workflows.github.shellPath(f.store.getAssistant(f.id));
  const env = fs.readFileSync(path.join(path.dirname(marker), "shell-env.sh"), "utf8");
  assert.match(env, /^export GH_HOST='ghe\.example\.com'$/m);
  // Without writing anything, the same directories serve the approval analysis.
  assert.deepEqual(f.workflows.github.shellDirs(f.store.getAssistant(f.id)), [marker]);
  f.save({ credentialId: f.work.id, level: "read" });
  f.workflows.github.shellPath(f.store.getAssistant(f.id));
  assert.doesNotMatch(
    fs.readFileSync(path.join(path.dirname(marker), "shell-env.sh"), "utf8"),
    /GH_HOST=/,
  );
});

test("a proposal may not grant GitHub above the lead's level", async (t) => {
  const f = await setup(t);
  f.save({ credentialId: f.work.id, level: "read" });
  const teams = new TeamStore({
    store: f.store,
    github: (id) => f.workflows.github.held(id),
  });
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  assert.throws(
    () =>
      teams.propose({
        operationId: "team-call",
        parentAttemptId: attempt.id,
        objective: "Push",
        members: [
          {
            name: "Pusher",
            role: "Git",
            assignment: "Push",
            grants: { github: "write" },
          },
        ],
      }),
    { key: "teamGrantNotHeld" },
  );
});

test("a promoted member keeps no GitHub access its lead granted", async (t) => {
  const f = await team(t, { github: "write" });
  for (const attempt of f.assistants.ledger.pending())
    f.assistants.ledger.transition(attempt.id, "completed");
  const member = f.teams.member(f.member.id);
  f.teams.promoteByLead(member.id, member.revision, {
    settings: { capabilities: {}, skills: [], shell: "off" },
  });
  assert.equal(f.agent().lifetime, "permanent");
  assert.equal(f.workflows.github.forAgent(f.agent()), null);
  assert.equal(f.workflows.github.held(f.agent().id), null);
});

test("a user agent's stored GitHub access never compiles", async (t) => {
  const f = await setup(t);
  f.save({ credentialId: f.work.id, level: "write" });
  // A forged or restored database turns the agent into a user agent with its access.
  const raw = f.store.storedAssistant(f.id);
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...raw,
      userAccess: {
        mode: "own",
        members: [{ userId: "u1", level: "chat" }],
        released: [],
      },
    }),
    f.id,
  );
  assert.equal(f.workflows.access.get(f.id).github.credentialId, f.work.id);
  const sections = f.compiled();
  assert.deepEqual(sections.servers, {});
  assert.deepEqual(sections.agentTools, {});
  const agent = f.store.getAssistant(f.id);
  assert.equal(f.workflows.github.forAgent(agent), null);
  assert.equal(f.workflows.github.describe(agent), null);
  assert.equal(f.workflows.github.held(f.id), null);
});
