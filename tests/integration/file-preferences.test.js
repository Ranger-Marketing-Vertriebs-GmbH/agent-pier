import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { FilePreferences } from "../../server/features/files/file-preferences.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";
import { fileFixture } from "../helpers/file-explorer.js";
import { applicationFixture } from "../helpers/application.js";

test("file preferences persist private host and scope records", async (t) => {
  const f = await fileFixture(t);
  const directory = path.join(f.project, "saved");
  await fs.mkdir(directory);
  const preferences = new FilePreferences({ dataDir: f.dataDir, home: f.home });

  assert.deepEqual(await preferences.get(f.globalScope), {
    favorites: [],
    showHidden: false,
  });
  assert.deepEqual(
    await preferences.update(f.globalScope, {
      favorites: [{ id: "saved", name: "Saved", path: directory }],
      showHidden: true,
    }),
    {
      favorites: [{ id: "saved", name: "Saved", path: directory }],
      showHidden: true,
    },
  );

  const file = path.join(f.dataDir, "files", "preferences.json");
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.values(stored.hosts), [
    {
      showHidden: true,
      favorites: [{ id: "saved", name: "Saved", path: directory }],
    },
  ]);
  assert.deepEqual(
    await new FilePreferences({ dataDir: f.dataDir, home: f.home }).get(f.globalScope),
    {
      favorites: [{ id: "saved", name: "Saved", path: directory }],
      showHidden: true,
    },
  );

  const otherHome = path.join(f.root, "other-home");
  await fs.mkdir(otherHome);
  const otherScope = await makeFileScope({ home: otherHome });
  const otherHost = new FilePreferences({ dataDir: f.dataDir, home: otherHome });
  assert.deepEqual(otherHost.get(otherScope), { favorites: [], showHidden: false });
  otherHost.update(otherScope, { showHidden: true });
  assert.deepEqual(preferences.get(f.globalScope).favorites, [
    { id: "saved", name: "Saved", path: directory },
  ]);
});

test("project favorites project shared host records and preserve records outside scope", async (t) => {
  const f = await fileFixture(t);
  const second = path.join(f.home, "second");
  const saved = path.join(f.project, "saved");
  const vanished = path.join(f.project, "vanished");
  const insideTarget = path.join(f.project, "inside-target");
  const insideLink = path.join(f.project, "inside-link");
  const escapeLink = path.join(f.project, "escape-link");
  await fs.mkdir(second);
  await fs.mkdir(saved);
  await fs.mkdir(insideTarget);
  await fs.symlink(insideTarget, insideLink);
  await fs.symlink(second, escapeLink);
  const sameRootScope = await makeFileScope({
    home: f.home,
    session: { id: "same-root", cwd: f.project, pipeline: { headless: true } },
  });
  const secondScope = await makeFileScope({
    home: f.home,
    session: { id: "second", cwd: second },
  });
  const preferences = new FilePreferences({ dataDir: f.dataDir, home: f.home });

  await preferences.update(f.globalScope, {
    favorites: [
      { id: "saved", name: "Saved", path: saved },
      { id: "vanished", name: "Vanished", path: vanished },
      { id: "inside-link", name: "Inside link", path: insideLink },
      { id: "escape-link", name: "Escape link", path: escapeLink },
      { id: "second", name: "Second", path: second },
    ],
  });

  const projected = [
    { id: "saved", name: "Saved", path: "saved" },
    { id: "vanished", name: "Vanished", path: "vanished" },
    { id: "inside-link", name: "Inside link", path: "inside-link" },
  ];
  assert.deepEqual((await preferences.get(f.projectScope)).favorites, projected);
  assert.deepEqual((await preferences.get(sameRootScope)).favorites, projected);
  assert.deepEqual((await preferences.get(secondScope)).favorites, [
    { id: "second", name: "Second", path: "" },
  ]);

  assert.deepEqual(
    await preferences.update(f.projectScope, {
      favorites: [
        { id: "saved", name: "Saved", path: "saved" },
        { id: "new", name: "New", path: "new" },
      ],
    }),
    {
      favorites: [
        { id: "saved", name: "Saved", path: "saved" },
        { id: "new", name: "New", path: "new" },
      ],
      showHidden: false,
    },
  );
  assert.deepEqual((await preferences.get(f.globalScope)).favorites, [
    { id: "saved", name: "Saved", path: saved },
    { id: "new", name: "New", path: path.join(f.project, "new") },
    { id: "escape-link", name: "Escape link", path: escapeLink },
    { id: "second", name: "Second", path: second },
  ]);
  assert.deepEqual((await preferences.get(secondScope)).favorites, [
    { id: "second", name: "Second", path: "" },
  ]);

  await preferences.update(f.globalScope, {
    favorites: [
      ...(await preferences.get(f.globalScope)).favorites,
      { id: "gone", name: "Gone", path: vanished },
    ],
  });
  assert.deepEqual((await preferences.get(f.projectScope)).favorites.at(-1), {
    id: "gone",
    name: "Gone",
    path: "vanished",
  });
  assert.deepEqual(await preferences.update(f.projectScope, { favorites: [] }), {
    favorites: [],
    showHidden: false,
  });
  assert.deepEqual((await preferences.get(f.globalScope)).favorites, [
    { id: "escape-link", name: "Escape link", path: escapeLink },
    { id: "second", name: "Second", path: second },
  ]);
});

test("file preferences reject malformed patches and cross-scope paths", async (t) => {
  const f = await fileFixture(t);
  const outside = path.join(f.home, "outside-favorite");
  const outsideLink = path.join(f.project, "outside-link");
  await fs.mkdir(outside);
  await fs.symlink(outside, outsideLink);
  const preferences = new FilePreferences({ dataDir: f.dataDir, home: f.home });
  for (const patch of [
    { unknown: true },
    { showHidden: "yes" },
    { favorites: [{ id: "escape", name: "Escape", path: "../outside" }] },
    { favorites: [{ id: "link", name: "Link", path: "outside-link" }] },
    {
      favorites: [
        { id: "duplicate", name: "One", path: "" },
        { id: "duplicate", name: "Two", path: "" },
      ],
    },
  ])
    assert.throws(
      () => preferences.update(f.projectScope, patch),
      (error) => error.code === "FILE_INVALID_PREFERENCES" && error.status === 400,
    );
});

test("preference routes bind writes to a freshly derived scope", async (t) => {
  const f = await applicationFixture(t);
  const first = path.join(f.home, "first");
  const second = path.join(f.home, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await f.application.sessions.save({
    id: "preference-session",
    name: "Preferences",
    tool: "shell",
    status: "exited",
    cwd: first,
  });
  const base = "/api/sessions/preference-session/files/explorer";
  const opened = await (await f.request(`${base}/context`)).json();
  const saved = await f.request(`${base}/preferences`, {
    method: "PATCH",
    headers: { "x-file-scope": opened.scopeId },
    body: {
      favorites: [{ id: "root", name: "Project", path: "" }],
      showHidden: true,
    },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(await saved.json(), {
    favorites: [{ id: "root", name: "Project", path: "" }],
    showHidden: true,
  });
  const missingHeader = await f.request(`${base}/preferences`, {
    method: "PATCH",
    body: { showHidden: false },
  });
  assert.equal(missingHeader.status, 409);
  assert.equal((await missingHeader.json()).code, "FILE_INVALID_SCOPE");

  await f.application.sessions.save({
    id: "preference-session",
    name: "Preferences",
    tool: "shell",
    status: "exited",
    cwd: second,
  });
  const stale = await f.request(`${base}/preferences`, {
    method: "PATCH",
    headers: { "x-file-scope": opened.scopeId },
    body: { showHidden: false },
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "FILE_INVALID_SCOPE");
  assert.deepEqual(await (await f.request(`${base}/preferences`)).json(), {
    favorites: [],
    showHidden: true,
  });
});
