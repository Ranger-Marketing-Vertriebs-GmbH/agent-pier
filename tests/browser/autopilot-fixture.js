import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { patchProgress } from "../../server/features/cli-profiles/skills/agentpier-composer/scripts/order-progress.mjs";

export async function controlRoomFixture(page, cleanups) {
  const f = await applicationFixture(
    { after: (cleanup) => cleanups.push(cleanup) },
    { listenPort: Number(process.env.AGENTPIER_FIXTURE_PORT || 0) },
  );
  const app = f.application;
  const repo = path.join(f.root, "Atlas");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=owner@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial commit",
  ]);
  const project = await (
    await f.request("/api/memory/projects", {
      method: "POST",
      body: { cwd: repo },
    })
  ).json();

  // Only the native CLI and its inference are replaced. Worktrees, sessions,
  // the progress file, owner policy, human requests, and cleanup use the app.
  app.tools = () => [{ id: "codex", name: "Codex", path: "/bin/sh", installed: true }];
  app.accounts.command = () => ({
    command: "/bin/sh",
    args: ["-c", "exec cat"],
    env: { HOME: f.home, PATH: "/bin:/usr/bin" },
  });
  app.chatDelivery.send = async () => ({ status: "accepted" });

  await page.context().addCookies([
    {
      name: "agentpier_session",
      value: f.cookie.slice(f.cookie.indexOf("=") + 1),
      url: f.url,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return {
    ...f,
    repo,
    project,
    progress(order, patch) {
      patchProgress(path.join(repo, ".git"), order.filename, patch);
    },
    async create(title, brief, requestId) {
      const response = await f.request("/api/autopilot/orders", {
        method: "POST",
        body: {
          projectId: project.id,
          title,
          brief,
          requestId,
          session: { tool: "codex" },
        },
      });
      const body = await response.json();
      if (response.status !== 201) throw new Error(body.error);
      return body;
    },
    async question(sessionId) {
      const file = app.requests.file(sessionId);
      const { token } = JSON.parse(await fs.readFile(file, "utf8"));
      const channel = new NativeRequestChannel({
        env: { AGENTPIER_REQUEST_FILE: file, AGENTPIER_REQUEST_TOKEN: token },
      });
      cleanups.push(() => channel.close());
      await channel.ready;
      const replies = [];
      channel.publish(
        "storage",
        {
          kind: "question",
          questions: [
            {
              id: "engine",
              header: "Storage decision",
              prompt: "Which storage engine should we use?",
              options: [
                { id: "sqlite", label: "SQLite" },
                { id: "postgres", label: "PostgreSQL" },
              ],
              multiple: false,
              allowOther: false,
            },
          ],
        },
        async (answer) => {
          replies.push(answer);
        },
      );
      return replies;
    },
    run(id, pipelineName, status) {
      return app.pipelines.store.create({
        id,
        projectId: project.id,
        cwd: repo,
        pipelineName,
        status,
        pipelineId: "import-jobs",
        task: "Verify the importer against the saved migration plan.",
        createdAt: "2026-11-23T12:00:00Z",
        currentNodeId: "review",
        nodes: [
          {
            id: "review",
            kind: "gate",
            label: "Migration review",
            status: status === "awaiting-human" ? "awaiting-gate" : "completed",
          },
        ],
        edges: [],
        executionLog: [],
      });
    },
  };
}

export const plan = [
  {
    id: "schema",
    title: "Prepare import storage",
    task: "Keep the migration reversible.",
    status: "completed",
    items: [
      {
        id: "mapping",
        title: "Map legacy fields",
        status: "completed",
        tickets: [
          {
            source: "github",
            key: "atlas/importer#42",
            title: "Document field mapping",
            status: "closed",
            url: "https://github.com/atlas/importer/issues/42",
          },
        ],
      },
    ],
  },
  {
    id: "rollout",
    title: "Roll out the new importer",
    dependsOn: ["schema"],
    status: "active",
    items: [{ id: "validate", title: "Verify migration coverage", status: "waiting" }],
  },
];
