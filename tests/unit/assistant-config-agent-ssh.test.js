import test from "node:test";
import assert from "node:assert/strict";
import { shellService } from "../helpers/assistant-shell-service.js";

// A live apply (AssistantConfig.applyOnce) with the agent SSH hooks of
// agent-ssh-shell-wiring.js stubbed: the exec PATH order and the instructions'
// "Plain SSH" section, and a failing sync never fails the turn.
function withSsh(t) {
  const f = shellService(t, ["Home"]);
  const [agent] = f.agents;
  f.store.updateAssistant(agent.id, { shell: "approval" }, agent.revision);
  const calls = [];
  Object.assign(f.config, {
    githubShellPath: () => ["/g/marker", "/g/bin"],
    sshShellPath: (a) => (calls.push(["path", a.id]), ["/s/bin"]),
    plainSsh: async (a) => {
      calls.push(["sync", a.id]);
      return { hosts: [{ name: "Proxmox 2", alias: "proxmox-2" }] };
    },
  });
  const agentsMd = () =>
    f.client.calls
      .filter((c) => c.method === "agents.files.set" && c.params.name === "AGENTS.md")
      .at(-1)?.params.content;
  return { ...f, agent, calls, agentsMd };
}

test("an apply syncs the SSH agent first, then compiles its bin/ and aliases", async (t) => {
  const f = withSsh(t);
  await f.config.apply(f.agent.id);
  assert.deepEqual(f.live(f.agent).tools.exec.pathPrepend, [
    "/g/marker",
    "/g/bin",
    "/s/bin",
    "/owner/bin",
  ]);
  // The turn's sync runs before the PATH entry is read.
  assert.deepEqual(
    f.calls.map(([kind]) => kind),
    ["sync", "path"],
  );
  assert.match(f.agentsMd(), /## Plain SSH\n.*"Proxmox 2": `ssh proxmox-2`/);
});

test("a failing SSH sync leaves the section out and the apply succeeds", async (t) => {
  const f = withSsh(t);
  f.config.plainSsh = async () => {
    throw Error("boom");
  };
  await f.config.apply(f.agent.id);
  assert.deepEqual(f.live(f.agent).tools.exec.pathPrepend, [
    "/g/marker",
    "/g/bin",
    "/s/bin",
    "/owner/bin",
  ]);
  assert.doesNotMatch(f.agentsMd(), /Plain SSH/);
  const stored = f.store.getAssistant(f.agent.id);
  assert.equal(stored.effectiveRevision, stored.revision);
});
