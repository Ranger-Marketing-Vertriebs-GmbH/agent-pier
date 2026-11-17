import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_SLOTS,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import { openClawAgentFiles } from "../../server/features/assistants/runtimes/openclaw/openclaw-agents.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";
import { hermesAgentFiles } from "../../server/features/assistants/runtimes/hermes/hermes-files.js";
import { hermesCapabilities } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { runtimePagesOf } from "../../server/features/assistants/runtimes/runtime-options.js";
import { withRuntime } from "../../server/features/assistants/runtimes/runtime-for.js";
import { wikiPage, wikiPages } from "../../server/features/assistants/agent-wiki.js";

// The read page of an agent's memory wiki (ADR 0007, step 7b): the owner reads the
// pages through the agentFiles sub-port (OpenClaw's wiki.overview and wiki.get), never
// from the vault on disk. Hermes declares the methods and lacks the capability.

const overview = {
  totalItems: 2,
  totalPages: 13,
  truncated: false,
  clusters: [
    {
      key: "synthesis",
      items: [
        {
          pagePath: "syntheses/quartz-notes.md",
          title: "Quartz Notes",
          kind: "synthesis",
          id: "synthesis.quartz-notes",
          updatedAt: "2026-11-17T08:06:02.293Z",
          claimCount: 1,
          snippet: "Quartz is grey.",
        },
      ],
    },
    {
      key: "entity",
      items: [
        {
          pagePath: "entities/owner.md",
          title: "Owner",
          kind: "entity",
          updatedAt: "2026-11-17T09:00:00.000Z",
          claimCount: 0,
        },
      ],
    },
  ],
};
const page = {
  corpus: "wiki",
  path: "syntheses/quartz-notes.md",
  title: "Quartz Notes",
  kind: "synthesis",
  content: "\n# Quartz Notes\n\nQuartz is grey.\n",
  totalLines: 4,
  truncated: false,
  id: "synthesis.quartz-notes",
  updatedAt: "2026-11-17T08:06:02.293Z",
  sourcePath: "/data/assistants/workspaces/a1/MEMORY.md",
};
function gateway(answers) {
  const calls = [];
  const client = {
    call: async (method, params) => {
      calls.push([method, params]);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
  };
  return { calls, files: openClawAgentFiles({ client }, () => client) };
}

test("the wiki is a capability of its own, and its page a slot of an agent", () => {
  assert.ok(RUNTIME_CAPABILITIES.includes("memoryWiki"));
  assert.ok(RUNTIME_SLOTS.includes("agent.page"));
  assert.deepEqual(hermesCapabilities.memoryWiki, {
    available: false,
    reason: "memoryWikiUnsupported",
  });
  assert.deepEqual(openClawDescriptor.surfaces, [
    {
      id: "memoryWiki",
      slot: "agent.capabilities",
      kind: "built",
      shows: "whileEnabled",
    },
    { id: "wiki", slot: "agent.page", kind: "built", shows: "whileEnabled" },
  ]);
});

test("OpenClaw lists the pages newest first and reads one page", async () => {
  const { calls, files } = gateway({ "wiki.overview": overview, "wiki.get": page });
  const listing = await files.wikiPages({ agentId: "ap-a1" });
  assert.deepEqual(listing, {
    state: "ready",
    totalPages: 13,
    truncated: false,
    pages: [
      {
        lookup: "entities/owner.md",
        title: "Owner",
        kind: "entity",
        updatedAt: "2026-11-17T09:00:00.000Z",
      },
      {
        lookup: "syntheses/quartz-notes.md",
        title: "Quartz Notes",
        kind: "synthesis",
        updatedAt: "2026-11-17T08:06:02.293Z",
      },
    ],
  });
  const read = await files.wikiPage({
    agentId: "ap-a1",
    lookup: "syntheses/quartz-notes.md",
  });
  // Only what the page shows: never the path of the note it came from.
  assert.deepEqual(read, {
    lookup: "syntheses/quartz-notes.md",
    title: "Quartz Notes",
    kind: "synthesis",
    updatedAt: "2026-11-17T08:06:02.293Z",
    content: "\n# Quartz Notes\n\nQuartz is grey.\n",
    truncated: false,
  });
  assert.deepEqual(calls[0], ["wiki.overview", { agentId: "ap-a1" }]);
  assert.equal(calls[1][0], "wiki.get");
  assert.equal(calls[1][1].agentId, "ap-a1");
  assert.equal(calls[1][1].lookup, "syntheses/quartz-notes.md");
});

test("a wiki still compiling lists no page yet; a missing page is null", async () => {
  const building = Object.assign(new Error("rebuilding"), {
    code: "UNAVAILABLE",
    retryable: true,
  });
  const { files } = gateway({ "wiki.overview": building, "wiki.get": null });
  assert.deepEqual(await files.wikiPages({ agentId: "ap-a1" }), {
    state: "building",
    totalPages: 0,
    truncated: false,
    pages: [],
  });
  assert.equal(await files.wikiPage({ agentId: "ap-a1", lookup: "x.md" }), null);
  const other = gateway({ "wiki.overview": new Error("closed") }).files;
  await assert.rejects(other.wikiPages({ agentId: "ap-a1" }), /closed/);
});

test("Hermes declares the methods and refuses them", async () => {
  const files = hermesAgentFiles({ client: null });
  await assert.rejects(files.wikiPages({ agentId: "x" }), { code: "UNSUPPORTED" });
  await assert.rejects(files.wikiPage({ agentId: "x", lookup: "y" }), {
    code: "UNSUPPORTED",
  });
});

test("an agent's runtime pages: the wiki's page while it keeps one", () => {
  const own = { id: "a1", runtimeOptions: { openclaw: { memoryWiki: true } } };
  assert.deepEqual(runtimePagesOf(own), ["wiki"]);
  assert.deepEqual(runtimePagesOf({ id: "a1" }), []);
  assert.deepEqual(
    runtimePagesOf({ ...own, userAccess: { mode: "own", members: [], released: [] } }),
    [],
  );
  assert.deepEqual(withRuntime(own, null).runtimePages, ["wiki"]);
  assert.equal("runtimePages" in withRuntime({ id: "a1" }, null), false);
});

// The service behind the routes, over a stub of the agents service and its runtime.
const assistants = (agent) => ({
  store: { getAssistant: () => agent },
  runtime: null,
  admit: (fn) => fn(),
  requireReady() {},
});
const over = (files, available = true) => ({
  runtimeOf: () => ({
    capabilities: () => ({ memoryWiki: { available } }),
    agentFiles: files,
  }),
});
const keeper = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  runtimeOptions: { openclaw: { memoryWiki: true } },
};

test("the routes read through the port, only for an agent that keeps a wiki", async () => {
  const { files } = gateway({ "wiki.overview": overview, "wiki.get": page });
  const owner = assistants(keeper);
  assert.equal((await wikiPages(owner, "a1", over(files))).pages.length, 2);
  assert.equal(
    (await wikiPage(owner, "a1", "syntheses/quartz-notes.md", over(files))).title,
    "Quartz Notes",
  );
  for (const lookup of [undefined, "", "x".repeat(513), ["a"]])
    await assert.rejects(wikiPage(owner, "a1", lookup, over(files)), { status: 400 });
  const none = gateway({ "wiki.get": null }).files;
  await assert.rejects(wikiPage(owner, "a1", "gone.md", over(none)), { status: 404 });
  // Without a wiki, or on a runtime without one, the page does not exist.
  await assert.rejects(
    wikiPages(assistants({ ...keeper, runtimeOptions: {} }), "a1", over(files)),
    { status: 404 },
  );
  await assert.rejects(wikiPages(owner, "a1", over(files, false)), { status: 404 });
  // A failing Gateway is unavailable, never its own words.
  const broken = gateway({ "wiki.overview": new Error("/secret/path") }).files;
  await assert.rejects(wikiPages(owner, "a1", over(broken)), (error) => {
    assert.equal(error.status, 503);
    assert.equal(String(error.message).includes("/secret/path"), false);
    return true;
  });
});

test("a wiki tool call that ends signals the agent's wiki; other steps do not", async () => {
  const { chatEventListener } =
    await import("../../server/features/assistants/gateway-wiring.js");
  const { RunSteps } = await import("../../server/features/assistants/run-steps.js");
  const signals = [];
  const listen = chatEventListener({
    store: { conversationOfSession: () => ({ id: "c1", assistantId: "a1" }) },
    ledger: { attemptForRun: () => null },
    runSteps: new RunSteps(),
    onWikiChange: (id) => signals.push(id),
  });
  const step = (name, phase) => ({
    kind: "tool",
    runId: "r1",
    sessionKey: "agent:ap-a1:x",
    step: { type: "tool", id: `${name}-${phase}`, name, phase },
  });
  listen(step("wiki_apply", "start"));
  listen(step("agentpier_workspace", "end"));
  assert.deepEqual(signals, []);
  listen(step("wiki_apply", "end"));
  listen(step("wiki_lint", "end"));
  assert.deepEqual(signals, ["a1", "a1"]);
});
