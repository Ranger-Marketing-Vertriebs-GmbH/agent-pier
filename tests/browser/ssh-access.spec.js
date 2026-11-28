import { addGrant, grantOption } from "../helpers/grant-picker.js";
import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";
import { openAccess, showKeys } from "./ssh-settings-helpers.js";
test("mobile SSH creation requires independently confirmed fingerprint and retains failed draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Zugang hinzufügen", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Build server");
  await page.getByLabel("Host", { exact: true }).fill("build.example.test");
  await page.getByLabel("Benutzername", { exact: true }).fill("deploy");
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Hostschlüssel abrufen", exact: true }).click();
  await expect(page.getByText("SHA256:verified-host", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: ".cache/ssh-host-confirm-mobile.png" });
  await page
    .getByLabel("Ich habe den Fingerabdruck unabhängig beim Serverbetreiber geprüft.")
    .check();
  state.fail = true;
  await save.click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue(
    "build.example.test",
  );
  state.fail = false;
  await save.click();
  await page
    .getByRole("button", { name: "Öffentlichen Schlüssel kopieren", exact: true })
    .click();
  expect(await page.evaluate(() => window.copiedText)).toBe("ssh-ed25519 public-fixture");
  expect(state.calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: ".cache/ssh-settings-mobile.png", fullPage: true });
});
test("existing session assignment exposes copy command without sending agent input and revoke retains failed draft", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.goto(baseURL + "/sessions/fixture-session");
  await page.getByRole("button", { name: "SSH-Zugänge", exact: true }).click();
  // "verwalten" leads to Zugänge › SSH/SFTP-Zugänge (Appendix A D-2).
  await expect(
    page.getByRole("link", { name: "SSH-Zugänge verwalten", exact: true }),
  ).toHaveAttribute("href", "/connections?section=ssh");
  await page.getByRole("checkbox", { name: /Build server/ }).check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page
    .getByText("Erweitert · manuelle Verbindungsbefehle", { exact: true })
    .click();
  await page.getByRole("button", { name: "Befehl kopieren", exact: true }).click();
  expect(await page.evaluate(() => window.copiedText)).toContain("ssh.mjs");
  await expect(page.getByText("-- uname -a", { exact: true })).toBeVisible();
  expect(state.base.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(await page.evaluate(() => window.sshTerminalInputs)).toEqual([]);
  await page.screenshot({ path: ".cache/ssh-session-desktop.png" });
  await page.getByRole("checkbox", { name: /Build server/ }).uncheck();
  state.fail = true;
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Build server/ })).not.toBeChecked();
  state.fail = false;
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Befehl kopieren", exact: true }),
  ).toHaveCount(0);
  expect(state.assignedIds).toEqual([]);
});

// The session SSH dialog chooses through GrantPicker
// (docs/ui-guide.md#choosing-what-a-session-may-use): search and rows on the left, the
// allowed list on the right, one checklist on phones.
async function openSessionSsh(page) {
  await page.goto(baseURL + "/sessions/fixture-session");
  await page.getByRole("button", { name: "SSH-Zugänge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".grant-picker")).toBeVisible();
  return dialog;
}
const sessionPuts = (state) =>
  state.calls
    .filter((call) => call.method === "PUT" && call.path.includes("/sessions/"))
    .map((call) => call.body);

test("the session SSH dialog finds an access by typing and keeps the payload", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = Array.from({ length: 24 }, (_, index) => {
    const name = `host-${String(index + 1).padStart(2, "0")}`;
    return { ...state.access, id: `ssh-${name}`, name, host: `${name}.example.test` };
  });
  const dialog = await openSessionSsh(page);
  const search = dialog.getByRole("searchbox", { name: "SSH-Zugänge durchsuchen" });
  await expect(search).toBeFocused();
  const choices = dialog.getByRole("group", { name: "SSH-Zugänge", exact: true });
  const allowed = dialog.getByRole("group", { name: /^Erlaubt in dieser Session/ });
  await search.fill("host-23");
  await expect(choices.getByRole("checkbox")).toHaveCount(1);
  await choices.getByRole("checkbox", { name: "host-23" }).check();
  await expect(allowed.getByText("host-23", { exact: true })).toBeVisible();
  await allowed.getByRole("button", { name: "host-23 entfernen" }).click();
  await expect(allowed.getByText("host-23", { exact: true })).toHaveCount(0);
  await expect(choices.getByRole("checkbox", { name: "host-23" })).not.toBeChecked();
  await choices.getByRole("checkbox", { name: "host-23" }).check();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByText("Gespeichert", { exact: true })).toBeVisible();
  expect(sessionPuts(state)).toEqual([{ accessIds: ["ssh-host-23"] }]);
});

test("the session SSH dialog is one checklist on a phone and keeps choices across the breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = await fixture(page);
  state.accesses = [state.access];
  const dialog = await openSessionSsh(page);
  const picker = dialog.locator(".grant-picker");
  await expect(picker).toHaveAttribute("data-arrangement", "split");
  await dialog.getByRole("checkbox", { name: "Build server" }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picker).toHaveAttribute("data-arrangement", "list");
  await expect(
    dialog.getByRole("heading", { name: "Erlaubt in dieser Session · 1" }),
  ).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Build server" })).toBeChecked();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(picker).toHaveAttribute("data-arrangement", "split");
  await expect(dialog.getByRole("checkbox", { name: "Build server" })).toBeChecked();
  expect(sessionPuts(state)).toEqual([]);
});

test("an inherited access stays allowed when its explicit assignment is removed", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  state.assignedIds = [state.access.id];
  state.inheritedIds = [state.access.id];
  const dialog = await openSessionSsh(page);
  const allowed = dialog.getByRole("group", { name: /^Erlaubt in dieser Session/ });
  await expect(allowed.getByText(/Vom Projekt verwaltet/)).toBeVisible();
  await expect(allowed.getByText(/Explizite Session-Zuordnung/)).toBeVisible();
  await allowed.getByRole("button", { name: "Explizite Zuordnung entfernen" }).click();
  await expect(allowed.getByText(/Explizite Session-Zuordnung/)).toHaveCount(0);
  await expect(allowed.getByText(/Vom Projekt verwaltet/)).toBeVisible();
  const box = dialog.getByRole("checkbox", { name: "Build server" });
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  // The locked row on the left says why it cannot be switched off.
  await expect(box).toHaveAccessibleDescription(/Vom Projekt verwaltet/);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => sessionPuts(state)).toEqual([{ accessIds: [] }]);
});

const manyAccesses = (state, count) =>
  Array.from({ length: count }, (_, index) => {
    const name = `host-${String(index + 1).padStart(2, "0")}`;
    return { ...state.access, id: `ssh-${name}`, name, host: `${name}.example.test` };
  });

test("the split SSH dialog keeps rows and Save reachable in a short window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 420 });
  const state = await fixture(page);
  state.accesses = manyAccesses(state, 40);
  const dialog = await openSessionSsh(page);
  await expect(dialog.locator(".grant-picker")).toHaveAttribute(
    "data-arrangement",
    "split",
  );
  const list = dialog.locator(".grant-picker-list");
  await list.scrollIntoViewIfNeeded();
  // Several rows fit, not just the search field.
  expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThan(108);
  const row = dialog.getByRole("checkbox", { name: "host-03" });
  await row.check();
  await expect(row).toBeChecked();
  const save = dialog.getByRole("button", { name: "Speichern", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  await save.click();
  await expect.poll(() => sessionPuts(state)).toEqual([{ accessIds: ["ssh-host-03"] }]);
});

test("the split SSH dialog keeps its height while the search narrows the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await fixture(page);
  state.accesses = manyAccesses(state, 40);
  const dialog = await openSessionSsh(page);
  const height = () => dialog.evaluate((element) => element.offsetHeight);
  const before = await height();
  await dialog
    .getByRole("searchbox", { name: "SSH-Zugänge durchsuchen" })
    .fill("host-07");
  await expect(
    dialog.getByRole("group", { name: "SSH-Zugänge", exact: true }).getByRole("checkbox"),
  ).toHaveCount(1);
  expect(await height()).toBe(before);
});

test("endpoint edits invalidate confirmation and deletion requires confirmation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.goto(baseURL + "/settings/ssh");
  await openAccess(page, "Build server");
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeEnabled();
  await page.getByLabel("Host", { exact: true }).fill("new.example.test");
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("dialog").getByText("SHA256:verified-host", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Hostschlüssel abrufen", exact: true }).click();
  await expect(save).toBeDisabled();
  await page
    .getByLabel("Ich habe den Fingerabdruck unabhängig beim Serverbetreiber geprüft.")
    .check();
  await save.click();
  expect(state.calls.find((call) => call.method === "PATCH").body.host).toBe(
    "new.example.test",
  );
  await page.getByRole("button", { name: "Verbindung testen", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Verbindung erfolgreich");
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  state.fail = true;
  await page.getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Noch keine SSH- oder SFTP-Zugänge" }),
  ).toBeVisible();
});

test("English management supports explicit key import and manual copying fallback", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    });
  });
  await page.goto(baseURL + "/settings/ssh");
  await expect(
    page.getByRole("heading", { name: "SSH/SFTP accesses", exact: true }),
  ).toBeVisible();
  await showKeys(page);
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Imported key");
  await page
    .getByRole("combobox", { name: "SSH key", exact: true })
    .selectOption("import");
  await page
    .getByLabel("Unencrypted private SSH key", { exact: true })
    .fill("fixture-only-not-a-real-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(
    state.calls.find((call) => call.method === "POST" && call.path === "/api/ssh-keys")
      .body.privateKey,
  ).toBe("fixture-only-not-a-real-key");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Imported key", exact: true }) })
    .getByRole("button", { name: "Copy public key", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Select and copy the text manually",
  );
  await expect(
    page.getByText("fixture-only-not-a-real-key", { exact: true }),
  ).toHaveCount(0);
});

test("launch selections are submitted and retained when launch fails", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  const launches = [];
  await page.route("**/api/sessions", (route) => {
    launches.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Launch rejected" } });
  });
  await page.goto(baseURL);
  await openNewSession(page);
  await page.locator(".launch-extensions > summary").click();
  const accesses = page.getByRole("group", { name: "SSH-Zugänge" });
  await addGrant(accesses, "SSH-Zugang hinzufügen", "Build server");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Session starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(launches[0].sshAccessIds).toEqual(["ssh-one"]);
  await expect(accesses.getByText("Build server", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("the add field marks an SFTP access and finds it by typing sftp", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [
    state.access,
    { ...state.access, id: "ssh-files", name: "File drop", type: "sftp" },
  ];
  await page.goto(baseURL);
  await openNewSession(page);
  await page.locator(".launch-extensions > summary").click();
  const accesses = page.getByRole("group", { name: "SSH-Zugänge" });
  const option = await grantOption(accesses, "SSH-Zugang hinzufügen", "sftp");
  await expect(option).toHaveCount(1);
  await expect(option).toContainText("File drop");
  await expect(option.locator(".add-picker-meta")).toHaveText("SFTP");
});

test("creation waits for the initial list so a delayed response cannot erase the new public key", async ({
  page,
}) => {
  const state = await fixture(page);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ssh-accesses", async (route) => {
    await pending;
    return route.fulfill({ json: { accesses: [] } });
  });
  await page.goto(baseURL + "/settings/ssh");
  const add = page.getByRole("button", { name: "Zugang hinzufügen", exact: true });
  try {
    await expect(add).toBeDisabled();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  } finally {
    release();
  }
  await expect(add).toBeEnabled();
});

test("legacy algorithms are an owner switch with a SHA-1 warning, saved per host", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await openAccess(page, "Build server");
  const details = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Build server", exact: true }),
  });
  const legacy = details
    .getByText("Legacy algorithms (ssh-rsa)", { exact: true })
    .locator("xpath=following-sibling::dd[1]");
  await expect(legacy).toHaveText("Off");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", { name: "Legacy algorithms (ssh-rsa)" });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(/SHA-1 is outdated/);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: ".cache/ssh-legacy-algorithms-form.png" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const patch = state.calls.find((call) => call.method === "PATCH");
  expect(patch.body.legacyAlgorithms).toBe(true);
  expect(patch.body.host).toBe("build.example.test");
  await expect(legacy).toHaveText("On");
  await expect(
    details.getByText("This host accepts outdated RSA signatures with SHA-1 (ssh-rsa)", {
      exact: false,
    }),
  ).toBeVisible();
  await page.screenshot({ path: ".cache/ssh-legacy-algorithms-details.png" });
  // SFTP hosts use the built-in client and show no switch.
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  await page.getByRole("radio", { name: "SFTP", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("switch", { name: "Legacy algorithms (ssh-rsa)" }),
  ).toHaveCount(0);
});

test("interactive shell is an owner switch per host and the test reports a refused command", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/settings/ssh");
  await openAccess(page, "Build server");
  const details = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Build server", exact: true }),
  });
  const row = details.getByText("Interactive shell (network devices)", { exact: true });
  await expect(row).toBeVisible();
  await expect(row.locator("xpath=following-sibling::dd[1]")).toHaveText("Off");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", {
    name: "Interactive shell (network devices)",
  });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(/answers pager prompts with a space/);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await dialog.screenshot({ path: ".cache/ssh-interactive-shell-form.png" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const patch = state.calls.find((call) => call.method === "PATCH");
  expect(patch.body.interactiveShell).toBe(true);
  expect(patch.body.legacyAlgorithms).toBe(false);
  await expect(row.locator("xpath=following-sibling::dd[1]")).toHaveText("On");
  // Test connection checks the sign-in; a device that does not know `true` passes.
  state.testResult = { ok: true, commandRejected: true };
  await details.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(details.getByRole("status")).toHaveText(
    "Signed in successfully; the device rejected the test command true.",
  );
  await details.screenshot({ path: ".cache/ssh-interactive-shell-details.png" });
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  await page.getByRole("radio", { name: "SFTP", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("switch", {
      name: "Interactive shell (network devices)",
    }),
  ).toHaveCount(0);
});
