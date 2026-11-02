import test from "node:test";
import assert from "node:assert/strict";
import { hermesBrowserUpload } from "../../server/features/assistants/hermes-browser-upload.js";
import {
  setFileInputFiles,
  uploadTab,
} from "../../server/features/assistants/runtimes/hermes/hermes-browser-files.js";
import { browserRefusals } from "../../server/features/assistants/team-plugin/tool-guard.js";
import { teamPluginFiles } from "../../server/features/assistants/runtimes/hermes/hermes-config/team-plugin.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";

const tab = (targetId, url) => ({
  targetId,
  type: "page",
  url,
  socket: `ws://x/${targetId}`,
});

test("the upload fills the page the agent names, or its only page", () => {
  const one = [tab("a", "https://shop.example/upload")];
  assert.equal(uploadTab(one).targetId, "a");
  const two = [...one, tab("b", "https://other.example/")];
  assert.throws(() => uploadTab(two), { code: "BROWSER_TAB_AMBIGUOUS" });
  assert.equal(uploadTab(two, { urlContains: "other" }).targetId, "b");
  assert.equal(uploadTab(two, { targetId: "a" }).targetId, "a");
  assert.throws(() => uploadTab(two, { urlContains: "none" }), {
    code: "BROWSER_NO_TAB",
  });
  assert.throws(() => uploadTab([]), { code: "BROWSER_NO_TAB" });
});

// A CDP page that answers the three DOM calls; `node` 0 names no element.
function fakeSocket(calls, { node = 7, refuse = false } = {}) {
  return class {
    constructor() {
      setTimeout(() => this.onopen(), 0);
    }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push([method, params]);
      const result =
        method === "DOM.getDocument"
          ? { root: { nodeId: 1 } }
          : method === "DOM.querySelector"
            ? { nodeId: node }
            : {};
      const answer =
        method === "DOM.setFileInputFiles" && refuse
          ? { id, error: { message: "Node is not a file input element" } }
          : { id, result };
      setTimeout(() => this.onmessage({ data: JSON.stringify(answer) }), 0);
    }
    close() {}
  };
}

test("CDP sets the staged files on the element the selector names", async () => {
  const calls = [];
  const page = tab("a", "https://shop.example/upload");
  const result = await setFileInputFiles(
    page,
    { selector: "#f", files: ["/staged/report.txt"] },
    fakeSocket(calls),
  );
  assert.deepEqual(result, { url: page.url });
  assert.deepEqual(calls.at(-1), [
    "DOM.setFileInputFiles",
    { nodeId: 7, files: ["/staged/report.txt"] },
  ]);
  await assert.rejects(
    setFileInputFiles(
      page,
      { selector: "#x", files: ["/s"] },
      fakeSocket([], { node: 0 }),
    ),
    { code: "BROWSER_NO_ELEMENT" },
  );
  await assert.rejects(
    setFileInputFiles(
      page,
      { selector: "p", files: ["/s"] },
      fakeSocket([], { refuse: true }),
    ),
    { code: "BROWSER_NOT_FILE_INPUT" },
  );
});

// A bridge whose policy, staging and browser are recorded.
function uploadBridge({
  allow = true,
  reason,
  staged = ["/up/agentpier-a1/x/report.txt"],
} = {}) {
  const calls = [];
  const agent = { id: "a1", runtime: "hermes", runtimeAgentId: "ap-a1" };
  const supervisor = {};
  attachHermesFleet(supervisor, {
    runtimeOf: () => ({
      browser: {
        request: async (call) => {
          calls.push(["browser", call]);
          return { url: "https://shop.example/upload" };
        },
      },
    }),
  });
  const bridge = {
    closed: false,
    agentOf: (id) => (id === "ap-a1" ? agent : null),
    browserPolicy: async (input) => {
      calls.push(["policy", input]);
      return allow ? { allow: true } : { allow: false, reason };
    },
    bound: () => [],
    routineRun: () => null,
    assistants: {
      runtime: supervisor,
      workflows: {
        browserUploads: {
          staging: {
            owned: (id, paths) =>
              id === "a1"
                ? paths.filter((p) => staged.includes(p)).map((p) => ({ path: p }))
                : [],
          },
          finished: (input) => calls.push(["finished", input.ok]),
        },
      },
    },
  };
  return { bridge, calls };
}

test("an upload passes the browser and staging checks, then sets the files and is audited", async () => {
  const { bridge, calls } = uploadBridge();
  const paths = ["/up/agentpier-a1/x/report.txt"];
  const answer = await hermesBrowserUpload(bridge, {
    agentId: "ap-a1",
    sessionKey: "agent:ap-a1:hermes:s1",
    paths,
  });
  assert.deepEqual(answer, { ok: true, files: 1, url: "https://shop.example/upload" });
  assert.deepEqual(calls[0], [
    "policy",
    { agentId: "ap-a1", sessionKey: "agent:ap-a1:hermes:s1", action: "upload", paths },
  ]);
  assert.deepEqual(calls[1][1].body, {
    selector: 'input[type="file"]',
    files: paths,
    urlContains: undefined,
  });
  assert.deepEqual(calls[2], ["finished", true]);
  // The policy's refusal is the model's reason; nothing reaches the browser.
  const refused = uploadBridge({ allow: false, reason: "uploadOutside" });
  assert.deepEqual(
    await hermesBrowserUpload(refused.bridge, {
      agentId: "ap-a1",
      paths: ["/etc/passwd"],
    }),
    { ok: false, message: browserRefusals.uploadOutside },
  );
  assert.equal(
    refused.calls.some(([kind]) => kind === "browser"),
    false,
  );
  // Another runtime's agent, or an unknown one, gets nothing.
  assert.equal((await hermesBrowserUpload(bridge, { agentId: "ap-x", paths })).ok, false);
  await assert.rejects(hermesBrowserUpload(bridge, { agentId: "ap-a1", paths: [] }), {
    key: "invalid",
  });
});

test("only an agent with AgentPier's browser gets the upload tool", () => {
  const agent = desiredAgent({ id: "a1", runtimeAgentId: "ap-a1", revision: 1 });
  const connection = { url: "http://127.0.0.1:1", token: "t" };
  const settings = (browser) =>
    JSON.parse(
      teamPluginFiles(agent, { connection, browser })[
        "plugins/agentpier-team/tools.json"
      ],
    );
  assert.equal(settings(true).browserUpload.name, "agentpier_browser_upload");
  assert.equal(settings(false).browserUpload, undefined);
});
