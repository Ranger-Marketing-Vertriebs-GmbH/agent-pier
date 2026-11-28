import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { device, installed, notInstalledView, view } from "../helpers/devices-fixture.js";
import { addGrant } from "../helpers/grant-picker.js";
import { openNewSession } from "../helpers/navigation.js";
import { talkFixture } from "./session-agent-talk-fixture.js";

// Android devices for coding sessions (docs/devices.md#devices-for-coding-sessions) on
// stubbed routes: the new-session dialog's choice (`deviceAccess`), a running
// session's Android devices dialog (GET/PUT /api/sessions/:id/devices, live topic
// `session.devices:<id>`, answered by the live stub from the GET route) and ⌘K's
// action. The sessions are talkFixture's: "Homelab deploy" with AgentPier tools and
// "Bare shell work" without. Set AGENTPIER_SCREENSHOT_DIR to keep screenshots.
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;
async function shoot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `devices-pr2-ui-${name}.png`) });
}

const pixel = device({ id: "d-0000000000a1", name: "Pixel test" });
const tablet = device({ id: "d-0000000000b2", name: "Tablet", state: "running" });
// A device the session "Homelab deploy" created itself.
const scratch = device({
  id: "d-0000000000c3",
  name: "Scratch",
  creator: { kind: "session", id: "deploy", name: "Homelab deploy", gone: false },
});

/**
 * talkFixture plus the device routes. `state.view` is GET /api/devices,
 * `state.grants[sessionId]` the stored access, `state.eligible[sessionId]` what the
 * server says of the session, `state.devicePuts` the PUTs, and `state.refuse` answers
 * the next PUT with that code.
 */
async function setup(
  page,
  { language = "en", shown = view([pixel, tablet, scratch]) } = {},
) {
  const state = await talkFixture(page, { language });
  Object.assign(state, {
    view: shown,
    grants: {
      deploy: { devices: [], create: false },
      bare: { devices: [], create: false },
    },
    eligible: { deploy: true, bare: true },
    devicePuts: [],
    refuse: null,
  });
  const access = (id) => {
    const granted = new Map(
      state.grants[id].devices.map((entry) => [entry.deviceId, entry.manage]),
    );
    return {
      availability: state.view.availability,
      eligible: state.eligible[id],
      tools: state.tools[id],
      create: state.grants[id].create,
      devices: state.view.devices.map(
        ({ id: deviceId, name, state: status, creator }) => {
          const own = creator.kind === "session" && creator.id === id;
          return {
            id: deviceId,
            name,
            state: status,
            creator,
            assigned: granted.has(deviceId),
            manage: own || granted.get(deviceId) === true,
            own,
          };
        },
      ),
    };
  };
  await page.route(/\/api\/devices(\/installation)?$/, (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/installation") ? installed() : state.view,
    }),
  );
  await page.route(/\/api\/sessions\/[^/]+\/devices$/, (route) => {
    const request = route.request();
    const id = decodeURIComponent(new URL(request.url()).pathname.split("/")[3]);
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      state.devicePuts.push({ id, body });
      if (state.refuse) {
        const code = state.refuse;
        state.refuse = null;
        return route.fulfill({ status: 409, json: { code, error: code } });
      }
      state.grants[id] = body;
    }
    return route.fulfill({ json: access(id) });
  });
  return state;
}

const dialog = (page) => page.getByRole("dialog");
const openDevices = (page) =>
  page.getByRole("button", { name: "Android devices", exact: true }).first().click();
const noOverflow = async (page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
// Every part of `scope` lies inside the screen's width.
async function inside(page, scope) {
  const width = page.viewportSize().width;
  for (const part of await scope.all()) {
    const box = await part.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  }
}
async function openLaunchDevices(page) {
  await page.goto(baseURL);
  await openNewSession(page);
  await dialog(page)
    .getByLabel(/^(Working directory|Arbeitsverzeichnis)$/)
    .fill("/work/homelab");
  await dialog(page).locator(".launch-extensions > summary").click();
  return dialog(page).locator("[data-launch-devices]");
}

test("the new-session dialog sends the chosen devices as deviceAccess", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, { shown: view([pixel, tablet]) });
  const devices = await openLaunchDevices(page);
  await liveStub.waitForSubscribe("devices");
  await expect(devices.getByRole("heading", { name: "Android devices" })).toBeVisible();
  // Nothing is granted by default.
  const create = devices.getByRole("switch", { name: "Create devices", exact: true });
  await expect(create).not.toBeChecked();
  await expect(devices.getByRole("switch")).toHaveCount(1);
  await addGrant(devices, "Add Android device", "Pixel test");
  await addGrant(devices, "Add Android device", "Tablet");
  const manage = devices.getByRole("switch", { name: "Reset and delete “Tablet”" });
  await expect(manage).not.toBeChecked();
  await expect(
    devices.getByRole("switch", { name: "Reset and delete “Pixel test”" }),
  ).not.toBeChecked();
  await manage.check();
  await create.check();
  await expect(
    dialog(page).getByText(/2 Android devices, may create devices/),
  ).toBeVisible();
  await devices.scrollIntoViewIfNeeded();
  await shoot(page, "launch-desktop");
  // A device removed again takes its switch with it.
  await devices.getByRole("button", { name: "Remove Pixel test" }).click();
  await expect(
    devices.getByRole("switch", { name: "Reset and delete “Pixel test”" }),
  ).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(state.launches.at(-1).deviceAccess).toEqual({
    devices: [{ deviceId: tablet.id, manage: true }],
    create: true,
  });
});

test("a launch without a choice sends no deviceAccess; a deleted device drops out", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, { shown: view([pixel, tablet]) });
  const devices = await openLaunchDevices(page);
  await addGrant(devices, "Add Android device", "Pixel test");
  await expect(dialog(page).getByText(/1 Android device\b/)).toBeVisible();
  // The device is deleted elsewhere: the push takes it out of the choice.
  state.view = view([tablet]);
  await liveStub.pushRest("devices");
  await expect(dialog(page).getByText(/1 Android device\b/)).toHaveCount(0);
  await expect(devices.getByRole("switch")).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(Object.hasOwn(state.launches.at(-1), "deviceAccess")).toBe(false);
});

test("without AgentPier tools the launch says that the device tools are missing", async ({
  page,
}) => {
  await setup(page, { shown: view([pixel]) });
  const devices = await openLaunchDevices(page);
  const note = devices.getByText(/Without AgentPier tools the session gets no device/);
  await devices.getByRole("switch", { name: "Create devices" }).check();
  await expect(note).toHaveCount(0);
  await dialog(page)
    .getByRole("checkbox", { name: /AgentPier tools/ })
    .uncheck();
  await expect(note).toBeVisible();
});

test("a switch below the open add list takes the first click", async ({ page }) => {
  await setup(page, { shown: view([pixel, tablet]) });
  const devices = await openLaunchDevices(page);
  await addGrant(devices, "Add Android device", "Pixel test");
  // The list stays open for the next device and lies above the permissions.
  const list = devices.getByRole("listbox");
  await expect(list).toBeVisible();
  const manage = devices.getByRole("switch", { name: "Reset and delete “Pixel test”" });
  await manage.click();
  await expect(manage).toBeChecked();
  await expect(list).toHaveCount(0);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  // A tap's click arrives in a later task than the end of its touch, so the list
  // must still be in place then.
  test("a switch below the open add list takes the first tap", async ({ page }) => {
    await setup(page, { shown: view([pixel, tablet]) });
    const devices = await openLaunchDevices(page);
    const field = devices.getByRole("combobox", { name: "Add Android device" });
    await field.tap();
    await field.fill("Pixel test");
    await devices.getByRole("option", { name: "Pixel test" }).tap();
    const list = devices.getByRole("listbox");
    await expect(list).toBeVisible();
    const manage = devices.getByRole("switch", {
      name: "Reset and delete “Pixel test”",
    });
    for (const checked of [true, false, true]) {
      await manage.tap();
      await expect(manage).toBeChecked({ checked });
      await expect(list).toHaveCount(0);
      // Open again above the switch for the next tap.
      await field.tap();
      await expect(list).toBeVisible();
    }
    // A touch that ends without a click (a scroll, a drag) closes the list too.
    await page.touchscreen.tap(5, 5);
    await expect(list).toHaveCount(0);
  });
});

test("a host without devices and a shell offer no device choice", async ({ page }) => {
  const state = await setup(page, { shown: notInstalledView() });
  const devices = await openLaunchDevices(page);
  await expect(dialog(page).getByRole("group", { name: "Agents" })).toBeVisible();
  await expect(devices).toHaveCount(0);
  await expect(dialog(page).getByText("Android devices")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(Object.hasOwn(state.launches.at(-1), "deviceAccess")).toBe(false);
  // A running session has no Android devices action either.
  await page.goto(baseURL + "/sessions/deploy/chat");
  await expect(page.getByRole("button", { name: "Agent access" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Android devices" })).toHaveCount(0);
});

test("a session's Android devices dialog saves devices and permissions", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page);
  state.grants.deploy = {
    devices: [{ deviceId: pixel.id, manage: false }],
    create: false,
  };
  await page.goto(baseURL + "/sessions/deploy/chat");
  await openDevices(page);
  await liveStub.waitForSubscribe("session.devices:deploy");
  const access = dialog(page);
  await expect(access.getByRole("heading", { name: "Android devices" })).toBeVisible();
  await expect(access.locator("[data-device-tools]")).toHaveAttribute(
    "data-device-tools",
    "ready",
  );
  await expect(access.getByText("Has the device tools", { exact: true })).toBeVisible();
  // The device the session created is its own: allowed, fixed, without a switch.
  const own = access.getByRole("checkbox", { name: "Scratch" });
  await expect(own).toBeChecked();
  await expect(own).toBeDisabled();
  await expect(own).toHaveAccessibleDescription(/created by this session/);
  await expect(
    access
      .getByRole("group", { name: /^Allowed in this session · 2/ })
      .getByText("created by this session", { exact: true }),
  ).toBeVisible();
  await expect(access.getByRole("switch", { name: /Scratch/ })).toHaveCount(0);
  await expect(access.getByRole("checkbox", { name: "Pixel test" })).toBeChecked();
  const pixelManage = access.getByRole("switch", {
    name: "Reset and delete “Pixel test”",
  });
  await expect(pixelManage).not.toBeChecked();
  await access.getByRole("checkbox", { name: "Tablet" }).check();
  await expect(
    access.getByRole("switch", { name: "Reset and delete “Tablet”" }),
  ).not.toBeChecked();
  await pixelManage.check();
  await access.getByRole("switch", { name: "Create devices", exact: true }).check();
  await shoot(page, "session-dialog-desktop");
  await access.getByRole("button", { name: "Save", exact: true }).click();
  await expect(access.getByText("Saved.", { exact: true })).toBeVisible();
  expect(state.devicePuts).toEqual([
    {
      id: "deploy",
      body: {
        devices: [
          { deviceId: pixel.id, manage: true },
          { deviceId: tablet.id, manage: false },
        ],
        create: true,
      },
    },
  ]);
  await expect(pixelManage).toBeChecked();
  // A refusal is said in words and keeps the choice.
  await access.getByRole("checkbox", { name: "Tablet" }).uncheck();
  state.refuse = "DEVICE_SESSION_INELIGIBLE";
  await access.getByRole("button", { name: "Save", exact: true }).click();
  await expect(access.getByRole("alert")).toContainText(
    "Devices can be given to your own running coding sessions only",
  );
  await expect(access.getByRole("checkbox", { name: "Tablet" })).not.toBeChecked();
});

test("a pushed change shows while nothing is unsaved and never drops a draft", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/sessions/deploy/chat");
  await openDevices(page);
  await liveStub.waitForSubscribe("session.devices:deploy");
  const access = dialog(page);
  const tabletBox = access.getByRole("checkbox", { name: "Tablet" });
  await expect(tabletBox).not.toBeChecked();
  // Assigned elsewhere (another tab): the untouched dialog follows.
  state.grants.deploy = {
    devices: [{ deviceId: tablet.id, manage: true }],
    create: false,
  };
  await liveStub.pushRest("session.devices:deploy");
  await expect(tabletBox).toBeChecked();
  await expect(
    access.getByRole("switch", { name: "Reset and delete “Tablet”" }),
  ).toBeChecked();
  // With an unsaved choice a push keeps it, minus a device that was deleted.
  await access.getByRole("checkbox", { name: "Pixel test" }).check();
  state.view = view([pixel, scratch]);
  state.grants.deploy = { devices: [], create: false };
  await liveStub.pushRest("session.devices:deploy");
  await expect(access.getByRole("checkbox", { name: "Tablet" })).toHaveCount(0);
  await expect(access.getByRole("checkbox", { name: "Pixel test" })).toBeChecked();
  await access.getByRole("button", { name: "Save", exact: true }).click();
  await expect(access.getByText("Saved.", { exact: true })).toBeVisible();
  expect(state.devicePuts.at(-1).body).toEqual({
    devices: [{ deviceId: pixel.id, manage: false }],
    create: false,
  });
});

test("a session without AgentPier tools says when it gets the device tools", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/sessions/bare/chat");
  await openDevices(page);
  const access = dialog(page);
  await expect(access.locator("[data-device-tools]")).toHaveAttribute(
    "data-device-tools",
    "missing",
  );
  await expect(
    access.getByText(
      /The assignment is saved, but the session gets the device tools only after a reload with AgentPier tools/,
    ),
  ).toBeVisible();
  // The assignment is still offered and stored.
  await access.getByRole("checkbox", { name: "Pixel test" }).check();
  await shoot(page, "session-dialog-tools-missing-desktop");
  await access.getByRole("button", { name: "Save", exact: true }).click();
  await expect(access.getByText("Saved.", { exact: true })).toBeVisible();
  expect(state.devicePuts.at(-1).id).toBe("bare");
});

test("a session that cannot be given devices says why and offers nothing", async ({
  page,
}) => {
  const state = await setup(page);
  state.eligible.deploy = false;
  await page.goto(baseURL + "/sessions/deploy/chat");
  await openDevices(page);
  const access = dialog(page);
  await expect(
    access.getByText(/Devices can be given to your own running coding sessions only/),
  ).toBeVisible();
  await expect(access.getByRole("checkbox")).toHaveCount(0);
  await expect(access.getByRole("switch")).toHaveCount(0);
  await expect(access.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("⌘K's Android devices opens the dialog of that running session", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/sessions/bare/chat");
  await expect(
    page.getByRole("button", { name: "Android devices" }).first(),
  ).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible();
  await search.getByRole("combobox").fill("android devices deploy");
  await search
    .getByRole("option", { name: /Homelab deploy · Android devices/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/sessions\/deploy(\/|$)/);
  await expect(
    dialog(page).getByRole("heading", { name: "Android devices" }),
  ).toBeVisible();
  await expect(dialog(page).getByText("Has the device tools")).toBeVisible();
});

test("in German the dialog and the launch choice use the German texts", async ({
  page,
}) => {
  const state = await setup(page, { language: "de" });
  state.grants.bare = { devices: [{ deviceId: pixel.id, manage: true }], create: true };
  await page.goto(baseURL + "/sessions/bare/chat");
  await page.getByRole("button", { name: "Android-Geräte", exact: true }).first().click();
  const access = dialog(page);
  await expect(access.getByRole("heading", { name: "Android-Geräte" })).toBeVisible();
  await expect(
    access.getByText(/Die Zuweisung ist gespeichert, aber die Session bekommt/),
  ).toBeVisible();
  await expect(
    access.getByRole("switch", { name: "„Pixel test“ zurücksetzen und löschen" }),
  ).toBeChecked();
  await expect(access.getByRole("switch", { name: "Geräte anlegen" })).toBeChecked();
  await expect(access.getByText("Berechtigungen", { exact: true })).toBeVisible();
  await shoot(page, "session-dialog-desktop-de");
  await access.getByRole("button", { name: "Schließen" }).first().click();
  const devices = await openLaunchDevices(page);
  await addGrant(devices, "Android-Gerät hinzufügen", "Tablet");
  await devices.getByRole("switch", { name: "Geräte anlegen" }).check();
  await expect(
    dialog(page).getByText(/1 Android-Gerät, darf Geräte anlegen/),
  ).toBeVisible();
  await devices.scrollIntoViewIfNeeded();
  await shoot(page, "launch-desktop-de");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the session's dialog is one checklist with the permissions below", async ({
    page,
  }) => {
    const state = await setup(page, {
      shown: view([
        device({
          id: "d-0000000000d4",
          name: "A device with quite a long name for a narrow screen",
        }),
        pixel,
        tablet,
        scratch,
      ]),
    });
    await page.goto(baseURL + "/sessions/deploy/chat");
    await page.getByRole("button", { name: "More actions" }).first().tap();
    await page.getByRole("menuitem", { name: "Android devices" }).tap();
    const access = dialog(page);
    await expect(access.getByRole("heading", { name: "Android devices" })).toBeVisible();
    await access
      .getByRole("checkbox", { name: /A device with quite a long name/ })
      .check();
    await access.getByRole("checkbox", { name: "Pixel test" }).check();
    const manage = access.getByRole("switch", {
      name: "Reset and delete “A device with quite a long name for a narrow screen”",
    });
    await manage.check();
    await noOverflow(page);
    await inside(page, access.locator(".list-row, .grant-picker-row, .switch"));
    // A switch's row is a full touch target.
    for (const row of await access.locator(".toggle-row").all())
      expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await shoot(page, "session-dialog-phone-top");
    await manage.scrollIntoViewIfNeeded();
    await shoot(page, "session-dialog-phone");
    await access.getByRole("button", { name: "Save", exact: true }).tap();
    await expect(access.getByText("Saved.", { exact: true })).toBeVisible();
    expect(state.devicePuts.at(-1).body).toEqual({
      devices: [
        { deviceId: "d-0000000000d4", manage: true },
        { deviceId: pixel.id, manage: false },
      ],
      create: false,
    });
  });

  test("the launch choice fits the screen", async ({ page }) => {
    const state = await setup(page, {
      shown: view([
        device({
          id: "d-0000000000d4",
          name: "A device with quite a long name for a narrow screen",
        }),
        tablet,
      ]),
    });
    const devices = await openLaunchDevices(page);
    await addGrant(devices, "Add Android device", "A device with quite a long name");
    await addGrant(devices, "Add Android device", "Tablet");
    await devices.getByRole("switch", { name: "Reset and delete “Tablet”" }).check();
    await noOverflow(page);
    await inside(page, devices.locator(".list-row, .switch"));
    await devices.scrollIntoViewIfNeeded();
    await shoot(page, "launch-phone");
    await dialog(page).getByRole("button", { name: "Start session", exact: true }).tap();
    await expect(page.getByRole("alert")).toContainText("Launch rejected");
    expect(state.launches.at(-1).deviceAccess).toEqual({
      devices: [
        { deviceId: "d-0000000000d4", manage: false },
        { deviceId: tablet.id, manage: true },
      ],
      create: false,
    });
  });
});
