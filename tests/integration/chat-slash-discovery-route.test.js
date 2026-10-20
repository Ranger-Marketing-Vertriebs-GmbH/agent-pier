import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("the slash command route serves a session's discovered commands to the owner only", async (t) => {
  const { home, project, application: app, url } = await applicationFixture(t);
  write(
    path.join(home, ".claude/commands/deploy.md"),
    "---\ndescription: Deploy the app\nargument-hint: [env]\n---\nPRIVATE BODY\n",
  );
  write(
    path.join(project, ".claude/skills/ship/SKILL.md"),
    "---\nname: ship\ndescription: Ship it\n---\nPRIVATE BODY\n",
  );
  const sessions = {
    claude: { id: "claude", accountId: "local-claude", tool: "claude", cwd: project },
    shell: { id: "shell", accountId: "local-shell", tool: "shell", cwd: project },
  };
  app.sessions.get = async (id) => {
    if (!sessions[id]) throw Object.assign(new Error("Missing session"), { status: 404 });
    return sessions[id];
  };
  const endpoint = (id) => `${url}/api/sessions/${id}/chat/slash-commands`;

  const response = await fixtureFetch(endpoint("claude"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.tool, "claude");
  assert.deepEqual(body.commands, [
    {
      name: "deploy",
      kind: "command",
      scope: "user",
      description: "Deploy the app",
      argumentHint: "[env]",
    },
    { name: "ship", kind: "skill", scope: "project", description: "Ship it" },
  ]);
  assert.equal(JSON.stringify(body).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(body).includes(home), false);

  // Without the login cookie the route answers nothing.
  const anonymous = await fetch(endpoint("claude"));
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.text()).includes("deploy"), false);

  assert.equal((await fixtureFetch(endpoint("shell"))).status, 409);
  assert.equal((await fixtureFetch(endpoint("missing"))).status, 404);
});
