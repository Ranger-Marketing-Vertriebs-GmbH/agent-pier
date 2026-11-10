import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RebuildPictures } from "../../server/features/craft/rebuild-pictures.js";
import {
  sessionPictureReader,
  stagePictures,
} from "../../server/features/craft/caller-pictures.js";
import { callCraftTool } from "../../server/features/craft/craft-mcp-tools.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { craftDefinition } from "../../server/features/assistants/team-plugin/craft-tool.js";
import { pictureLimits } from "../../server/features/craft/rebuild-pictures.js";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { rebuildsFixture } from "../helpers/craft-rebuilds-fixture.js";
import { png } from "../helpers/craft-pictures.js";

// Pictures a session (craft_rebuild_start) or an agent (agentpier_craft) names: only
// files it may already read, copied and checked by their bytes before Craft Anything
// sees them (craft/caller-pictures.js).

const codeOf = (promise) =>
  promise.then(
    () => null,
    (error) => error.code,
  );

function folders(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "craft-callers-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const outside = path.join(root, "outside");
  for (const dir of [
    cwd,
    dataDir,
    outside,
    path.join(cwd, ".git"),
    path.join(cwd, "shots"),
  ])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "shots", "home.png"), png());
  fs.writeFileSync(path.join(cwd, ".git", "a.png"), png());
  fs.writeFileSync(path.join(cwd, "notes.txt"), "not a picture");
  fs.writeFileSync(path.join(outside, "secret.png"), png());
  fs.writeFileSync(path.join(dataDir, "owner.png"), png());
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(cwd, "link.png"));
  fs.symlinkSync(outside, path.join(cwd, "linked"));
  fs.linkSync(path.join(outside, "secret.png"), path.join(cwd, "hard.png"));
  const pictures = new RebuildPictures({ dataDir });
  return { root, cwd, dataDir, outside, pictures };
}

test("a session reads pictures only from its own folder, never through a link", async (t) => {
  const f = folders(t);
  const stage = (list, cwd = f.cwd) =>
    stagePictures(f.pictures, list, sessionPictureReader(cwd, f.dataDir));
  const ids = await stage(["shots/home.png", path.join(f.cwd, "shots", "home.png")]);
  assert.equal(ids.length, 2);
  f.pictures.release(ids);
  const cases = {
    CRAFT_PICTURE_REFUSED: [
      path.join(f.outside, "secret.png"),
      "../outside/secret.png",
      "link.png",
      "linked/secret.png",
      "hard.png",
      ".git/a.png",
      path.join(f.dataDir, "owner.png"),
    ],
    CRAFT_PICTURE_NOT_FOUND: ["missing.png", "shots"],
    CRAFT_PICTURE_INVALID: ["notes.txt", "bad\u0000name"],
  };
  for (const [code, list] of Object.entries(cases))
    for (const entry of list)
      assert.equal(await codeOf(stage(["shots/home.png", entry])), code, entry);
  // A session that works inside AgentPier's data directory reads nothing there.
  const inside = path.join(f.dataDir, "work");
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, "a.png"), png());
  assert.equal(await codeOf(stage(["a.png"], inside)), "CRAFT_PICTURE_REFUSED");
  // Nothing stays staged from a refused list.
  assert.deepEqual(fs.readdirSync(f.pictures.dir), []);
  assert.equal(
    await codeOf(stage(Array(pictureLimits.count + 1).fill("shots/home.png"))),
    "CRAFT_PICTURE_INVALID",
  );
});

/** callCraftTool's services with a recording supervisor over `f.pictures`. */
function sessionServices(f) {
  const starts = [];
  return {
    starts,
    config: { dataDir: f.dataDir },
    sessionMcp: { grantFor: () => ({ allResources: true }) },
    sessions: { get: async () => ({ id: "s1", cwd: f.cwd }) },
    craft: { state: () => ({ installed: true }) },
    craftRebuilds: {
      pictures: f.pictures,
      start: async (input, options) => {
        const files = f.pictures.take(input.pictures ?? []);
        starts.push({
          input,
          options,
          bytes: files.map((file) => fs.readFileSync(file)),
        });
        f.pictures.discard(files);
        return { id: "r1", projectId: "p1", name: "x", folder: "/x", status: "building" };
      },
    },
  };
}

test("craft_rebuild_start passes a session's own pictures as staged copies", async (t) => {
  const f = folders(t);
  const services = sessionServices(f);
  const context = { sessionId: "s1", revalidate() {} };
  const result = await callCraftTool(
    services,
    "craft_rebuild_start",
    { request: "Like this", pictures: ["shots/home.png"], requestId: "a" },
    context,
  );
  assert.equal(result.id, "r1");
  const [start] = services.starts;
  assert.equal(start.options.source, "session");
  assert.equal(start.input.pictures.length, 1);
  assert.match(start.input.pictures[0], /^[a-f0-9]{32}$/, "an id, never the path");
  assert.deepEqual(start.bytes, [png()]);
  const refused = await codeOf(
    callCraftTool(
      services,
      "craft_rebuild_start",
      { request: "X", pictures: [path.join(f.outside, "secret.png")], requestId: "b" },
      context,
    ),
  );
  assert.equal(refused, "CRAFT_PICTURE_REFUSED");
  assert.equal(services.starts.length, 1);
  const tooMany = await codeOf(
    callCraftTool(
      services,
      "craft_rebuild_start",
      { request: "X", pictures: Array(11).fill("shots/home.png"), requestId: "c" },
      context,
    ),
  );
  assert.equal(tooMany, "CRAFT_REBUILD_INVALID_INPUT");
  assert.deepEqual(fs.readdirSync(f.pictures.dir), []);
});

/** agentpier_craft over the real workflows and a real supervisor. */
async function agentFixture(t) {
  const f = await agentProjectFixture(t);
  const r = rebuildsFixture(t);
  f.services.craftRebuilds = r.rebuilds;
  f.services.craft = { state: () => ({ installed: true }) };
  const workspace = path.join(f.assistants.attachments.config.workspaces, f.id);
  fs.mkdirSync(path.join(workspace, "shots"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "shots", "home.png"), png());
  const call = async (input) =>
    f.workflows.craft.invoke(await f.invocation(randomUUID()), input);
  const code = (input) =>
    call(input).then(
      () => null,
      (error) => toolError(error).code,
    );
  return { ...f, r, workspace, call, code };
}

test("agentpier_craft takes pictures from the agent's workspace", async (t) => {
  const f = await agentFixture(t);
  const started = await f.call({
    action: "start",
    request: "A shop like these screenshots",
    pictures: [{ path: "shots/home.png" }],
  });
  const view = f.r.rebuilds.get(started.id);
  assert.equal(view.target, "-");
  assert.deepEqual(fs.readdirSync(path.join(view.folder, "reference")), [
    "picture-1.png",
  ]);
  assert.deepEqual(fs.readdirSync(f.r.rebuilds.pictures.dir), []);
});

test("agentpier_craft refuses pictures the agent may not read", async (t) => {
  const f = await agentFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "craft-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.png"), png());
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(f.workspace, "link.png"));
  fs.writeFileSync(path.join(f.workspace, "notes.txt"), "text");
  fs.mkdirSync(path.join(f.workspace, ".agentpier"));
  fs.writeFileSync(path.join(f.workspace, ".agentpier", "a.png"), png());
  const start = (picture) => ({ action: "start", request: "X", pictures: [picture] });
  const cases = [
    [{ path: path.join(outside, "secret.png") }, "CRAFT_PICTURE_REFUSED"],
    [{ path: "../../secret.png" }, "CRAFT_PICTURE_REFUSED"],
    [{ path: "link.png" }, "CRAFT_PICTURE_REFUSED"],
    [{ path: ".agentpier/a.png" }, "CRAFT_PICTURE_REFUSED"],
    // A project folder the agent holds no grant for.
    [{ path: "a.png", projectId: f.project.id }, "CRAFT_PICTURE_REFUSED"],
    [{ path: "missing.png" }, "CRAFT_PICTURE_NOT_FOUND"],
    [{ path: "notes.txt" }, "CRAFT_PICTURE_INVALID"],
    [{ path: "shots/home.png", extra: true }, "CRAFT_PICTURE_INVALID"],
    ["shots/home.png", "CRAFT_PICTURE_INVALID"],
  ];
  for (const [picture, code] of cases)
    assert.equal(await f.code(start(picture)), code, JSON.stringify(picture));
  assert.equal(f.r.rebuilds.list().length, 0);
  assert.deepEqual(
    fs.existsSync(f.r.rebuilds.pictures.dir)
      ? fs.readdirSync(f.r.rebuilds.pictures.dir)
      : [],
    [],
  );
});

test("the plugin offers pictures within the server's limits", () => {
  const { parameters, description } = craftDefinition.craft;
  const pictures = parameters.properties.pictures;
  assert.equal(pictures.maxItems, pictureLimits.count);
  assert.deepEqual(pictures.items.required, ["path"]);
  assert.equal(pictures.items.additionalProperties, false);
  assert.match(description, /pictures/);
  assert.match(description, /20 MB/);
});
