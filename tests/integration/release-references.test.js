import test from "node:test";
import assert from "node:assert/strict";
import { releaseSessionReferences } from "../../server/features/operations/release-references.js";

const release = "/opt/agentpier/releases/1.0.0";
const other = "/opt/agentpier/releases/1.1.0";
const data = "/Users/me/Library/Application Support/AgentPier/data";
const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const second = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const proc = (pid, ppid, command) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${command}`;
const launcher = (pid, ppid, session, root = release) =>
  proc(
    pid,
    ppid,
    `${root}/bin/node ${root}/bin/node ${root}/server/terminal-launcher.js ${data}/sessions/${session}.launch.json`,
  );

test("launcher lines map to session ids with and without shell quoting", () => {
  const output = [
    launcher(100, 50, id),
    proc(
      101,
      50,
      `sh sh -c '${release}/bin/node' '${release}/server/terminal-launcher.js' '${data}/sessions/${second}.launch.json'`,
    ),
    launcher(102, 50, second, other),
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id, second],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});

test("descendants of a session launcher are helpers whatever they run", () => {
  const output = [
    launcher(100, 50, id),
    proc(200, 100, `claude claude --plugin-dir ${data}/plugins/x`),
    proc(
      300,
      200,
      `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`,
    ),
    proc(
      301,
      200,
      `node ${release}/bin/node ${release}/server/features/memory/memory-mcp.js --data-dir "${data}" --session ${id}`,
    ),
    proc(302, 200, `node ${release}/bin/node /Users/me/project/node_modules/.bin/vite`),
    proc(400, 302, `node ${release}/bin/node /Users/me/project/worker.js`),
    proc(
      101,
      50,
      `codex codex -c mcp_servers.agentpier_session={command="${release}/bin/node",args=["${release}/server/features/mcp/session-stdio.js","--socket","/tmp/x.sock","--capability","SECRET-TOKEN"]}`,
    ),
  ].join("\n");
  const result = releaseSessionReferences(output, [release]);
  assert.deepEqual(result, {
    sessionIds: [id],
    helpers: 4,
    helperReferences: [
      { reference: "vendor/agentbus/agentpier/mcp.js" },
      { reference: "server/features/memory/memory-mcp.js" },
      { reference: "bin/node" },
      { reference: "bin/node" },
    ],
    nodeOnly: 0,
    unidentified: [{ reference: "server/features/mcp/session-stdio.js" }],
  });
  assert.ok(!JSON.stringify(result).includes("SECRET-TOKEN"));
});

test("processes outside any session are node-only or unidentified", () => {
  const output = [
    launcher(100, 50, id),
    proc(500, 1, `node ${release}/bin/node /Users/me/tool.js`),
    proc(
      501,
      1,
      `node ${release}/bin/node ${release}/server/features/pipelines/verify-supervisor.js /tmp/run`,
    ),
    proc(
      502,
      7,
      `node ${release}/bin/node ${release}/server/features/operations/release-helper.js /tmp/req.json`,
    ),
    proc(503, 1, `node ${release}/bin/node ${release}/server/index.js`),
    proc(504, 1, `node ${release}/bin/node ${release}/server/terminal-launcher.js`),
    proc(505, 1, `bash bash -lc 'echo ${release}/README.md'`),
    proc(506, 1, `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`),
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 1,
    unidentified: [
      { reference: "server/features/pipelines/verify-supervisor.js" },
      { reference: "server/features/operations/release-helper.js" },
      { reference: "server/index.js" },
      { reference: "server/terminal-launcher.js" },
      { reference: "README.md" },
      { reference: "vendor/agentbus/agentpier/mcp.js" },
    ],
  });
});

test("ancestry survives parent cycles and lines without pid columns have no ancestry", () => {
  const output = [
    launcher(100, 50, id),
    proc(600, 601, `node ${release}/bin/node ${release}/server/a.js`),
    proc(601, 600, `node ${release}/bin/node ${release}/server/b.js`),
    `node ${release}/bin/node ${release}/server/c.js`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]).unidentified, [
    { reference: "server/a.js" },
    { reference: "server/b.js" },
    { reference: "server/c.js" },
  ]);
});

test("duplicate session ids across realpath and symlinked release paths collapse and empty inputs are inert", () => {
  const link = "/opt/agentpier-link/releases/1.0.0";
  assert.deepEqual(
    releaseSessionReferences(launcher(100, 50, id, link), [release, link]).sessionIds,
    [id],
  );
  const empty = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
  assert.deepEqual(releaseSessionReferences("", [release]), empty);
  assert.deepEqual(releaseSessionReferences(launcher(100, 50, id), []), empty);
});
