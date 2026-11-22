import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesContractBrowser, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// A temporary team member's browser on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME) with this machine's browser app: a Hermes lead
// with the browser grants it to a task member, the member's home turns Hermes's
// browser on, and a delegated task opens a local page in the member's own
// AgentPier-owned Chromium, held as a member slot (agent-browsers.js ownMemberSlot).
// The member's shell is what its lead grants it; this lead grants none (no shell
// level, "Team members may use shell and SSH" off), so Hermes offers the member
// browser_cdp, not browser_exec.
// The browser app: hermesContractBrowser (hermes-native.js).
const contractBrowser = hermesContractBrowser();
const options = {
  skip: contractBrowser.skip,
  timeout: contractTimeout(1500000),
};

async function until(check, ms, label) {
  let value;
  await eventually(async () => !!(value = await check()), ms, label);
  return value;
}

test(
  "Hermes contract: a task member browses with its lead's grant in a Chromium of its own",
  options,
  async (t) => {
    const page = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>Member page</title></head><body>Hi</body></html>");
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    t.after(() => page.close());
    const url = `http://127.0.0.1:${page.address().port}/`;
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    contractBrowser.use(app);
    const { assistants, fleet } = app;
    // The local page is a private address: the owner allows those for agent browsers.
    const network = await json(await app.f.request("/api/assistant-browser-network"));
    await json(
      await app.f.request("/api/assistant-browser-network", {
        method: "PUT",
        body: {
          revision: network.revision,
          allowPrivateNetwork: true,
          confirmRestart: true,
        },
      }),
    );
    const created = await app.createAgent({ name: "Hermes lead" });
    const lead = await json(
      await app.f.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        body: {
          revision: created.revision,
          capabilities: { ...created.capabilities, browser: true },
          confirmRestart: true,
        },
      }),
    );
    await app.ready(lead);

    const chat = await app.chat(lead);
    const ask = "Please build a team that checks the page.";
    const proposal = {
      objective: "Check the page",
      members: [
        {
          name: "Surfer",
          role: "Browser",
          assignment: "Say hello to the lead.",
          grants: { browser: true },
        },
      ],
      ownerRequestedTeam: true,
      ownerRequestQuote: ask,
    };
    await chat.send(
      "team",
      `${ask}\nCALL: agentpier_team_propose ${JSON.stringify(proposal)}`,
    );
    await chat.reply("TOOL_DONE");
    const team = await until(
      () => assistants.teams.store.list().find((x) => x.parentAssistantId === lead.id),
      60000,
      "the team",
    );
    const record = await until(
      () =>
        assistants.teams.store
          .members(team.id)
          .find((m) => m.conversationId && m.assistantId),
      300000,
      "the provisioned member",
    );
    const member = assistants.store.getAssistant(record.assistantId);
    assert.equal(member.runtime, "hermes");
    assert.notEqual(member.lifetime, "permanent");
    await app.ready(member);
    const memberHome = fleet.sets.get(member.runtimeAgentId).supervisor.agentPaths();
    const config = readHermesConfig(
      fs.readFileSync(path.join(memberHome.hermesHome, "config.yaml"), "utf8"),
    );
    assert.equal(config.agent.disabled_toolsets.includes("browser"), false);
    assert.match(config.browser.cdp_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const memberChat = app.conversation(
      assistants.store.getConversation(record.conversationId),
    );
    await memberChat.reply("ECHO:");

    // A delegated task opens the page in the member's own Chromium.
    const open = { method: "Target.createTarget", params: { url } };
    const task = `CALL: browser_cdp ${JSON.stringify(open)}`;
    await chat.send(
      "delegate",
      `CALL: agentpier_team_delegate ${JSON.stringify({ memberId: record.id, task })}`,
    );
    await chat.reply(/TOOL_DONE: .*requestId/);
    await memberChat.reply(/TOOL_DONE:[\s\S]*targetId/);
    assert.equal(assistants.browsers.isRunning(member.id), true);
    const port = Number(new URL(config.browser.cdp_url).port);
    await eventually(
      async () =>
        (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(
          (tab) => tab.title === "Member page",
        ),
      60000,
      "the member page in the member's browser",
    );
    assert.equal(
      assistants.browsers.viewProfile(member.id).name,
      `agent-${member.id.toLowerCase()}`,
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).ok, true);

    await fleet.close();
    await eventually(
      async () => {
        try {
          return !(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
        } catch {
          return true;
        }
      },
      30000,
      "the member's browser to stop",
    );
    assert.deepEqual(
      await strayAfterStop({ root: path.dirname(memberHome.hermesHome) }),
      [],
    );
  },
);
