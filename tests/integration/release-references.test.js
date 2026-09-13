import test from "node:test";
import assert from "node:assert/strict";
import { releaseSessionReferences } from "../../server/features/operations/release-references.js";

const release = "/opt/agentpier/releases/1.0.0";
const other = "/opt/agentpier/releases/1.1.0";
const data = "/Users/me/Library/Application Support/AgentPier/data";
const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const second = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("launcher lines map to session ids with and without shell quoting", () => {
  const output = [
    `${release}/bin/node ${release}/bin/node ${release}/server/terminal-launcher.js ${data}/sessions/${id}.launch.json`,
    `sh sh -c '${release}/bin/node' '${release}/server/terminal-launcher.js' '${data}/sessions/${second}.launch.json'`,
    `${other}/bin/node ${other}/bin/node ${other}/server/terminal-launcher.js ${data}/sessions/${second}.launch.json`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id, second],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});

test("session-owned helpers, node-only processes and foreign processes are classified separately", () => {
  const output = [
    `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`,
    `node ${release}/bin/node ${release}/server/native-session-binding.js hook`,
    `codex codex -c hooks.SessionStart=[{command="\\"$AGENTPIER_HOOK_NODE\\" \\"${release}/server/native-session-binding.js\\""}] -c mcp_servers.agentpier.args=["${release}/vendor/agentbus/agentpier/mcp.js"]`,
    `node ${release}/bin/node /Users/me/project/node_modules/.bin/vite`,
    `node ${release}/bin/node ${release}/server/features/pipelines/verify-supervisor.js /tmp/run`,
    `node ${release}/bin/node ${release}/server/terminal-launcher.js`,
    `bash bash -lc 'echo ${release}/README.md'`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [],
    helpers: 3,
    helperReferences: [
      { reference: "vendor/agentbus/agentpier/mcp.js" },
      { reference: "server/native-session-binding.js" },
      { reference: "server/native-session-binding.js" },
    ],
    nodeOnly: 1,
    unidentified: [
      { reference: "server/features/pipelines/verify-supervisor.js" },
      { reference: "server/terminal-launcher.js" },
      { reference: "README.md" },
    ],
  });
});

test("duplicate session ids across realpath and symlinked release paths collapse", () => {
  const link = "/opt/agentpier-link/releases/1.0.0";
  const output = `${link}/bin/node ${link}/bin/node ${link}/server/terminal-launcher.js ${data}/sessions/${id}.launch.json`;
  assert.deepEqual(releaseSessionReferences(output, [release, link]).sessionIds, [id]);
  assert.deepEqual(releaseSessionReferences("", [release]), {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});
