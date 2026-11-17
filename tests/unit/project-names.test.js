import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  isShortProjectName,
  PROJECT_NAME_MAX,
  suggestProjectName,
} from "../../server/features/projects/project-names.js";
import { cleanName, cleanStart } from "../../server/features/craft/rebuild-input.js";
import { validDirectoryName } from "../../server/lib/directories.js";
import { shownProjectName } from "../../web/features/craft/start-project-name.js";

// The owner's report: a rebuild's project was named after the whole request.
const prompt = "Eine App die das gleiche kann wie die Adresse jedes Feature";

test("a request is never a short project name", () => {
  assert.equal(isShortProjectName(prompt), false);
  assert.equal(isShortProjectName("x".repeat(PROJECT_NAME_MAX)), true);
  assert.equal(isShortProjectName("x".repeat(PROJECT_NAME_MAX + 1)), false);
  assert.equal(isShortProjectName("one two three four five six"), true);
  assert.equal(isShortProjectName("one two three four five six seven"), false);
  assert.equal(isShortProjectName("a-b-c-d-e-f-g"), false);
  for (const ok of ["Shop", "shop-redesign", "Ünïcödé", "Café 2 ½"])
    assert.equal(isShortProjectName(ok), true, ok);
  assert.equal(isShortProjectName(42), false);
});

test("suggestions take a few telling words of the request, or the target", () => {
  assert.equal(suggestProjectName(prompt), "app-adresse-feature");
  assert.equal(
    suggestProjectName(prompt, "https://www.Example.com/shop?x=1"),
    "example-com",
  );
  assert.equal(suggestProjectName("x", "/Applications/Notes.app"), "notes");
  assert.equal(suggestProjectName("Build me a counter app"), "counter-app");
  assert.equal(suggestProjectName("Rebuild the\nTodo app please"), "todo-app");
  assert.equal(suggestProjectName("x", "-"), "x");
  // Nothing telling left: the creator must name the project.
  for (const empty of ["", "  ", "the a", "Rebuild", "!!!", undefined, null])
    assert.equal(suggestProjectName(empty), null, String(empty));
});

test("every suggestion is a short, valid folder name", () =>
  fc.assert(
    fc.property(
      fc.string({ maxLength: 400, unit: "grapheme" }),
      fc.webUrl(),
      (text, url) => {
        for (const name of [suggestProjectName(text), suggestProjectName(text, url)]) {
          if (name === null) continue;
          assert.ok(isShortProjectName(name), name);
          assert.ok(validDirectoryName(name) && !name.startsWith("."), name);
        }
      },
    ),
  ));

const throwsStatus = (run) => assert.throws(run, (e) => e.status === 400);

test("a rebuild's name is the given short name, else a derived one, never the request", () => {
  assert.equal(cleanName(" notes-clone ", prompt, "-"), "notes-clone");
  assert.equal(cleanName(undefined, prompt, "-"), "app-adresse-feature");
  assert.equal(cleanName(null, prompt, "https://example.com"), "example-com");
  throwsStatus(() => cleanName(undefined, "Rebuild", "-"));
  for (const bad of [prompt, "", " ", ".hidden", "a/b", "a‮b", "a\nb", 7])
    throwsStatus(() => cleanName(bad, "x", "-"));
  const settings = { accountId: "a", mode: "clean-room", autoMode: false };
  assert.equal(
    cleanStart({ request: prompt }, "owner", settings).name,
    "app-adresse-feature",
  );
  assert.equal(
    cleanStart({ request: prompt, name: "adressen" }, "agent", settings).name,
    "adressen",
  );
  throwsStatus(() => cleanStart({ request: prompt, name: prompt }, "session", settings));
});

test("the start form prefills a short name until the owner edits it", () => {
  const form = {
    request: prompt,
    targetKind: "none",
    target: "",
    name: "",
    nameEdited: false,
  };
  assert.equal(shownProjectName(form), "app-adresse-feature");
  assert.equal(
    shownProjectName({ ...form, targetKind: "url", target: "https://example.com" }),
    "example-com",
  );
  // A target the form does not send does not name the project.
  assert.equal(
    shownProjectName({ ...form, targetKind: "pictures", target: "https://example.com" }),
    "app-adresse-feature",
  );
  assert.equal(shownProjectName({ ...form, request: "Rebuild" }), "");
  assert.equal(shownProjectName({ ...form, nameEdited: true, name: "" }), "");
  assert.equal(shownProjectName({ ...form, nameEdited: true, name: "mine" }), "mine");
});
