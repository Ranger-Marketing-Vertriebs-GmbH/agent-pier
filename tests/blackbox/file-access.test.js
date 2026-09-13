import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

async function saveSession(application, session) {
  await application.sessions.save({
    name: session.id,
    tool: "shell",
    status: "exited",
    ...session,
  });
}

test("machine tokens cannot read the global filesystem", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/files/context", {
    headers: { authorization: "Bearer fixture-machine-token" },
  });
  assert.equal(response.status, 403);
});

test("authenticated owner gets a global context and bounded reads", async (t) => {
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.home, "visible.txt"), "owner-visible");

  const response = await f.request(
    "/api/files/context?sessionId=untrusted&root=%2Fprivate&home=%2Fprivate",
  );
  assert.equal(response.status, 200, await response.clone().text());
  const context = await response.json();
  assert.equal(context.home, f.home);
  assert.equal(context.root, path.parse(f.home).root);
  assert.equal(context.kind, "global");
  assert.equal(context.readOnly, false);
  assert.equal(context.limits.listPageSize, 200);
  assert.match(context.scopeId, /^f1:/);

  const selected = path.join(f.home, "visible.txt");
  const metadata = await f.request(
    `/api/files/metadata?path=${encodeURIComponent(selected)}`,
  );
  assert.equal(metadata.status, 200, await metadata.clone().text());
  assert.equal((await metadata.json()).path, selected);

  const preview = await f.request(
    `/api/files/preview?path=${encodeURIComponent(selected)}`,
  );
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.deepEqual(await preview.json(), {
    path: selected,
    type: "text",
    text: "owner-visible",
  });

  const listing = await f.request(
    `/api/files/entries?${new URLSearchParams({ path: f.home, hidden: "0" })}`,
  );
  assert.equal(listing.status, 200, await listing.clone().text());
  assert.equal(
    (await listing.json()).entries.some((entry) => entry.name === "visible.txt"),
    true,
  );
});

test("file APIs require login and reject foreign origins and cross-site fetches", async (t) => {
  const anonymous = await applicationFixture(t, { authenticateFixture: false });
  assert.equal((await anonymous.request("/api/files/context")).status, 401);

  const f = await applicationFixture(t);
  assert.equal(
    (
      await f.request("/api/files/context", {
        origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/files/context", {
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
      })
    ).status,
    403,
  );
});

test("project contexts stay session-scoped and re-read changed server state", async (t) => {
  const f = await applicationFixture(t);
  const first = path.join(f.root, "project-one");
  const second = path.join(f.root, "project-two");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, "inside.txt"), "inside");
  await saveSession(f.application, {
    id: "project-session",
    cwd: first,
    pipeline: { headless: true },
  });

  const endpoint = "/api/sessions/project-session/files/explorer/context";
  const initial = await (
    await f.request(`${endpoint}?root=${encodeURIComponent(second)}`)
  ).json();
  assert.equal(initial.kind, "project");
  assert.equal(initial.root, first);
  assert.equal(initial.readOnly, true);

  const outside = await f.request(
    `/api/sessions/project-session/files/explorer/metadata?path=${encodeURIComponent(second)}`,
  );
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).code, "FILE_OUTSIDE_SCOPE");

  const global = await f.request(
    `/api/files/metadata?path=${encodeURIComponent(path.join(first, "inside.txt"))}`,
  );
  assert.equal(global.status, 200, await global.clone().text());

  await saveSession(f.application, {
    id: "project-session",
    cwd: second,
    pipeline: { headless: true },
  });
  const changed = await (await f.request(endpoint)).json();
  assert.equal(changed.root, second);
  assert.notEqual(changed.scopeId, initial.scopeId);

  const missing = await f.request("/api/sessions/missing-session/files/explorer/context");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: "Dateioperation fehlgeschlagen.",
    code: "FILE_INVALID_SCOPE",
    args: {},
  });
});

test("file errors expose only stable inert data", async (t) => {
  const f = await applicationFixture(t);
  const pathLookingText = "../settings?token=secret#fragment";
  await saveSession(f.application, { id: "safe-errors", cwd: f.home });
  const response = await f.request(
    `/api/sessions/safe-errors/files/explorer/metadata?path=${encodeURIComponent(pathLookingText)}`,
  );
  assert.equal(response.status, 403);
  const issue = await response.json();
  assert.deepEqual(Object.keys(issue).sort(), ["args", "code", "error"]);
  assert.equal(issue.code, "FILE_OUTSIDE_SCOPE");
  assert.deepEqual(issue.args, {});
  assert.equal(JSON.stringify(issue).includes(pathLookingText), false);
  assert.equal(JSON.stringify(issue).includes("secret"), false);

  const invalidPage = await f.request("/api/files/entries?page=not-a-page");
  assert.equal(invalidPage.status, 400);
  assert.equal((await invalidPage.json()).code, "FILE_INVALID_PAGE");
});
