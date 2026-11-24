import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { resolveMessage } from "../../server/lib/i18n/message-keys.js";

test("the owner opens a normal Composer chat, sees legacy orders, and can pause without starting a pipeline", async (t) => {
  const f = await applicationFixture(t, {
    listenPort: Number(process.env.AGENTPIER_PORT || 0),
  });
  const app = f.application;
  execFileSync("git", ["init", "-q", "-b", "main", f.project]);
  execFileSync("git", [
    "-C",
    f.project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  ]);
  const { id: projectId } = await (
    await f.request("/api/memory/projects", { method: "POST", body: { cwd: f.project } })
  ).json();
  const base = "/api/autopilot/orders";
  const directory = path.join(f.project, ".git", "agentpier-composer");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "legacy.json"),
    JSON.stringify({ topic: "Historical order" }),
  );
  const {
    orders: [legacy],
  } = await (await f.request(base)).json();
  assert.equal(legacy.title, "Historical order");
  assert.equal(legacy.projectId, projectId);
  assert.equal(legacy.allowMerge, false);
  assert.equal(legacy.session, null);
  const refused = await (
    await f.request(base + "/" + legacy.id, { method: "DELETE" })
  ).json();
  assert.equal(
    resolveMessage(englishServerMessages, refused.messageKey),
    englishServerMessages.autopilot.cleanupUnavailable,
  );
  assert.equal((await fs.readdir(directory)).includes("legacy.json"), true);

  // Exercise the real account, skill, worktree, launch and capability wiring.
  // The disposable CLI and its delivery receipt stand in for paid inference.
  app.tools = () => [{ id: "codex", path: "/bin/sh", installed: true }];
  app.accounts.command = () => ({
    command: "/bin/sh",
    args: ["-c", "exec cat"],
    env: { HOME: f.home, PATH: "/bin:/usr/bin" },
  });
  const prompts = [];
  app.chatDelivery.send = async (_id, msg) => {
    prompts.push(msg.text);
    return { status: "accepted" };
  };
  const body = {
    projectId,
    requestId: "request-1",
    title: "Migration",
    brief: "Plan the change".padEnd(65536, "."),
    session: { tool: "codex", accountId: "local-codex" },
  };
  const created = await f.request(base, { method: "POST", body });
  const order = await created.json();
  assert.equal(created.status, 201, order.error);
  assert.equal(order.projectId, projectId);
  assert.equal(order.state, "draft");
  assert.match(order.session.link, /\/chat$/);
  const session = await app.sessions.get(order.session.id);
  assert.equal(session.cwd, order.worktree);
  assert.equal(session.agentpierTools.enabled, true);
  assert.deepEqual(session.agentpierTools.selection.projectIds, []);
  assert.equal(session.agentpierTools.selection.currentProject, true);
  assert.equal(app.pipelines.store.all().length, 0);
  assert.equal(prompts.length, 1);
  const pause = await (
    await f.request(base + "/" + order.id + "/pause", { method: "POST" })
  ).json();
  assert.equal(pause.state, "paused");
  const replay = await (
    await f.request(base, {
      method: "POST",
      body: { ...body, session: { accountId: "local-codex", tool: "codex" } },
    })
  ).json();
  assert.equal(replay.session.id, order.session.id);
  assert.equal(replay.manualPaused, true);
  assert.equal(prompts.length, 1);
  const user = await signedInUser(f);
  assert.equal((await f.request(base, { headers: { cookie: user.cookie } })).status, 404);
  assert.equal(
    app.live.resolve({ role: "user" }, "autopilot.orders.changed:" + projectId),
    null,
  );
});
