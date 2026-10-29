import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SSH_AGENT_HINT_ENV,
  SSH_HINT_ENV,
  SFTP_HINT_ENV,
  sshReminder,
} from "../../server/features/ssh/ssh-hook.js";

const hook = fileURLToPath(
  new URL("../../server/features/ssh/ssh-hook.js", import.meta.url),
);

function startHint(env) {
  const base = { ...process.env };
  for (const name of [SSH_AGENT_HINT_ENV, SSH_HINT_ENV, SFTP_HINT_ENV]) delete base[name];
  const result = spawnSync(process.execPath, [hook], {
    input: "{}",
    env: { ...base, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

test("the hint names plain ssh only when the agent is on", () => {
  const on = sshReminder("", { agent: true, sftp: false });
  assert.match(on, /plain OpenSSH through this session's agent/);
  assert.match(on, /ssh <alias>, scp, sftp, rsync -e ssh and git over SSH/);
  assert.match(on, /tunnels \(-L, -R, -D\)/);
  assert.match(on, /ssh -F "\$AGENTPIER_SSH_CONFIG" <alias>/);
  assert.doesNotMatch(sshReminder("", { agent: false, sftp: false }), /plain OpenSSH/);
});

test("the agent sentence uses the tool prefix for the host list", () => {
  assert.match(
    sshReminder("agentpier_ssh_", { agent: true, sftp: false }),
    /agentpier_ssh_ssh_list_hosts shows each host's alias/,
  );
});

test("the start hook reads the agent flag from the launch environment", () => {
  assert.match(startHint({ [SSH_AGENT_HINT_ENV]: "1" }), /plain OpenSSH/);
  assert.doesNotMatch(startHint({}), /plain OpenSSH/);
  assert.doesNotMatch(startHint({ [SSH_AGENT_HINT_ENV]: "0" }), /plain OpenSSH/);
});
