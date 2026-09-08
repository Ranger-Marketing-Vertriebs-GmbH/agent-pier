import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as toml } from "smol-toml";
import { applicationFixture } from "../helpers/application.js";
const revision = "a".repeat(40);
const markdown =
  "---\nname: Frontend Expert\ndescription: Builds accessible interfaces\nmodel: sonnet\ntools: Bash\n---\n# Expert\nUse the selected project carefully.\n";
async function fixture(t) {
  const f = await applicationFixture(t);
  const urls = [];
  f.application.agency.fetchImpl = async (url) => {
    urls.push(String(url));
    if (url.includes("/git/ref/"))
      return new Response(JSON.stringify({ object: { sha: revision } }));
    if (url.includes("/git/trees/"))
      return new Response(
        JSON.stringify({
          sha: revision,
          truncated: false,
          tree: [
            { path: "engineering/frontend.md", type: "blob", size: 500 },
            { path: "scripts/install.sh", type: "blob", size: 200 },
            { path: "README.md", type: "blob", size: 200 },
          ],
        }),
      );
    if (url.endsWith("/LICENSE"))
      return new Response(
        "MIT License\nCopyright (c) Agency Agents contributors\nPermission is hereby granted, free of charge...",
      );
    return new Response(markdown);
  };
  return { ...f, urls };
}
for (const tool of ["claude", "codex", "opencode"])
  test(`Agency ${tool} imports a pinned native agent without executing scripts or forcing model/permissions`, async (t) => {
    const f = await fixture(t),
      endpoint = `/api/accounts/local-${tool}/agency`;
    const catalog = await (await f.request(endpoint)).json();
    assert.equal(catalog.items.length, 1);
    const id = catalog.items[0].id;
    assert.equal(catalog.revision, revision);
    const preview = await (
      await f.request(
        endpoint + `/preview?id=${encodeURIComponent(id)}&revision=${revision}`,
      )
    ).json();
    assert.equal(preview.name, "Frontend Expert");
    const response = await f.request(endpoint, {
      method: "POST",
      body: { id, revision },
    });
    assert.equal(response.status, 201);
    const installed = await response.json();
    const content = await fs.readFile(installed.path, "utf8");
    if (tool === "codex") {
      const config = toml(content);
      assert.equal(config.name, "Frontend Expert");
      assert.ok(config.developer_instructions.includes("# Expert"));
      assert.equal(config.model, undefined);
    } else {
      assert.ok(content.includes("description:"));
      assert.ok(!content.includes("sonnet"));
      assert.ok(!content.includes("tools:"));
    }
    assert.ok(
      f.urls
        .filter((url) => url.includes("raw.githubusercontent.com"))
        .every((url) => url.includes(revision)),
    );
    assert.ok(f.urls.every((url) => !url.includes("install.sh")));
    assert.equal(
      (await f.request(endpoint, { method: "POST", body: { id, revision } })).status,
      409,
    );
    assert.equal(
      (await f.request(endpoint + "/" + id, { method: "DELETE" })).status,
      204,
    );
    await assert.rejects(fs.access(installed.path));
  });
test("Agency rejects obsolete catalog revisions and preserves user-modified agent files", async (t) => {
  const f = await fixture(t),
    endpoint = "/api/accounts/local-claude/agency";
  const catalog = await (await f.request(endpoint)).json();
  const id = catalog.items[0].id;
  assert.equal(
    (
      await f.request(endpoint, {
        method: "POST",
        body: { id, revision: "b".repeat(40) },
      })
    ).status,
    409,
  );
  const installed = await (
    await f.request(endpoint, { method: "POST", body: { id, revision } })
  ).json();
  await fs.writeFile(installed.path, "user-owned changes");
  assert.equal((await f.request(endpoint + "/" + id, { method: "DELETE" })).status, 409);
  assert.equal(await fs.readFile(installed.path, "utf8"), "user-owned changes");
  assert.equal(
    (await f.request(endpoint + "/preview?id=..%2F..%2Fprivate&revision=" + revision))
      .status,
    404,
  );
  assert.ok(path.isAbsolute(installed.path));
});
