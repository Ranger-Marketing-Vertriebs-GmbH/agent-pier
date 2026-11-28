import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  device,
  installation,
  installed,
  notInstalledView,
  pinned,
  view,
} from "../helpers/devices-fixture.js";
import { isLiveStubRequest } from "../helpers/live-stub.js";
import { settingsBar, settingsRow } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

test.use({ locale: "en-GB" });

// Settings › General › Android devices: each state the server reports (the live
// topics `devices` and `devices.installation`, read from their routes here and pushed
// per change), the installation with its terms, the devices' lifecycle behind their
// confirmations, and the limits. Set AGENTPIER_SCREENSHOT_DIR to keep a screenshot
// of the main states.
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;
async function shoot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `devices-ui-${name}.png`) });
}

// The routes as the server answers them (server/http/routes/devices.js). `state.next`
// replaces one answer: `{ status, json }`, or a function that waits (a held request).
async function setup(page, { status = installed(), devices = [], shown } = {}) {
  const state = await operationsFixture(page);
  Object.assign(state, {
    installation: status,
    view: shown ?? view(devices),
    requests: [],
    next: null,
  });
  const counted = () => {
    const list = state.view.devices;
    state.view = {
      ...state.view,
      counts: {
        total: list.length,
        running: list.filter((entry) =>
          ["starting", "running", "stopping"].includes(entry.state),
        ).length,
      },
    };
  };
  const change = (id, patch) => {
    state.view = {
      ...state.view,
      devices: state.view.devices.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    };
    counted();
    return state.view.devices.find((entry) => entry.id === id);
  };
  state.change = change;
  await page.route(/\/api\/devices(\/[^?]*)?$/, async (route) => {
    const request = route.request();
    const method = request.method();
    const target = new URL(request.url()).pathname.slice("/api/devices".length);
    if (method === "GET")
      return route.fulfill({
        json: target === "/installation" ? state.installation : state.view,
      });
    if (isLiveStubRequest(request)) return route.fulfill({ status: 404, json: {} });
    const body = request.postData() ? request.postDataJSON() : null;
    state.requests.push({ method, path: target, body });
    if (state.next) {
      const next = state.next;
      state.next = null;
      const answer = typeof next === "function" ? await next() : next;
      if (answer) return route.fulfill(answer);
    }
    if (target === "/installation/install") {
      state.installation = installation({
        ...state.installation,
        state: "downloading",
        requested: true,
        failure: null,
        terms: { accepted: true, acceptedAt: 1795000000000, by: "owner" },
      });
      return route.fulfill({ status: 202, json: state.installation });
    }
    if (target === "/installation/cancel") {
      state.installation = installation({ ...state.installation, state: "absent" });
      return route.fulfill({ status: 202, json: state.installation });
    }
    if (target === "/installation/remove") {
      state.view = notInstalledView({ settings: state.view.settings });
      state.installation = installation({ ...state.installation, state: "removing" });
      return route.fulfill({ status: 202, json: state.installation });
    }
    if (target === "/settings") {
      state.view = { ...state.view, settings: { ...state.view.settings, ...body } };
      return route.fulfill({ json: state.view.settings });
    }
    if (target === "" && method === "POST") {
      const created = device({ id: "d-0000000000ff", name: body.name, diskBytes: 1024 });
      state.view = { ...state.view, devices: [...state.view.devices, created] };
      counted();
      return route.fulfill({ status: 201, json: created });
    }
    const [, id, action] = /^\/([^/]+)(?:\/(start|stop|reset))?$/.exec(target) ?? [];
    if (method === "DELETE") {
      state.view = {
        ...state.view,
        devices: state.view.devices.filter((entry) => entry.id !== id),
      };
      counted();
      return route.fulfill({ status: 204, body: "" });
    }
    const states = { start: "starting", stop: "stopping", reset: "stopped" };
    return route.fulfill({
      status: 202,
      json: change(id, { state: states[action], failure: null }),
    });
  });
  return state;
}
// A request the test answers itself: `{ answer(response) }` once it was sent.
function held(state) {
  let release;
  state.next = () => new Promise((resolve) => (release = resolve));
  return { answer: (response = null) => release(response) };
}
const refusal = (code, extra = {}, status = 409) => ({
  status,
  json: { code, error: code, ...extra },
});
const open = (page) => page.goto(baseURL + "/settings/devices");
const group = (page, name) => page.getByRole("region", { name, exact: true });
const row = (page, name) => page.getByRole("group", { name, exact: true });
const sent = (state, method, target) =>
  state.requests.filter((entry) => entry.method === method && entry.path === target);
// Requests of the app itself, not the stub's reads of the topics' routes.
function appRequests(page) {
  const seen = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && !isLiveStubRequest(request))
      seen.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return seen;
}

test("a host that cannot run devices says why and offers no installation", async ({
  page,
}) => {
  await setup(page, {
    status: installation({ available: false, reason: "DEVICES_KVM_DENIED" }),
    shown: view([], {
      availability: { available: false, reason: "DEVICES_KVM_DENIED" },
    }),
  });
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Android devices");
  const install = group(page, "Installation");
  await expect(install.locator(".list-row-status")).toHaveText("Not available");
  await expect(install.getByRole("alert")).toContainText(
    "AgentPier may not open /dev/kvm",
  );
  await expect(install.getByRole("alert")).toContainText("kvm group");
  await expect(install.getByRole("button")).toHaveCount(0);
  const list = group(page, "Devices");
  await expect(list).toContainText("This computer cannot run Android devices.");
  await expect(list.getByRole("button", { name: "+ New device" })).toBeDisabled();
  // Missing virtualization reads differently.
  await shoot(page, "unavailable");
});

test("installing asks with the terms, then shows the pushed progress", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, { status: installation(), shown: notInstalledView() });
  await open(page);
  const install = group(page, "Installation");
  await expect(install.locator(".list-row-status")).toHaveText("Not installed");
  await expect(install).toContainText("2.2 GB to download, 5.5 GB on disk");
  await expect(group(page, "Devices")).toContainText(
    "Install the Android components above to create devices.",
  );
  await shoot(page, "not-installed");

  await install.getByRole("button", { name: "Install …" }).click();
  const dialog = page.getByRole("dialog", { name: "Install Android devices?" });
  await expect(dialog).toContainText(
    "three components from dl.google.com into its data directory: 2.2 GB to download, 5.5 GB on disk",
  );
  await expect(dialog).toContainText("Android Emulator 37.3.10");
  await expect(dialog).toContainText("Android SDK Platform-Tools 37.0.3 (adb)");
  await expect(dialog).toContainText(
    "Android API 36 (arm64-v8a), without the Play Store",
  );
  await expect(dialog).toContainText("By installing you accept them");
  const licence = dialog.getByRole("link", {
    name: "Android Software Development Kit License Agreement",
  });
  await expect(licence).toHaveAttribute(
    "href",
    "https://developer.android.com/studio/terms",
  );
  await expect(licence).toHaveAttribute("target", "_blank");
  await expect(dialog.getByRole("link")).toHaveCount(2);
  await shoot(page, "install-dialog");
  // Cancel is the default and installs nothing.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests).toEqual([]);

  // Only the accepting button installs; it stays off until the answer.
  await install.getByRole("button", { name: "Install …" }).click();
  const request = held(state);
  const accept = dialog.getByRole("button", { name: "Accept and install" });
  await accept.click();
  await expect(accept).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.poll(() => sent(state, "POST", "/installation/install").length).toBe(1);
  request.answer();
  await expect(dialog).toHaveCount(0);
  expect(state.requests).toEqual([
    { method: "POST", path: "/installation/install", body: { acceptTerms: true } },
  ]);
  await expect(install.locator(".list-row-status")).toHaveText("Downloading");
  await expect(install.getByRole("status")).toHaveText("Starting the download");
  await expect(install.getByRole("button", { name: "Install …" })).toHaveCount(0);

  // Each step is pushed over `devices.installation`; the page asks for nothing.
  const requests = appRequests(page);
  const push = async (patch) => {
    state.installation = installation({ ...state.installation, ...patch });
    await liveStub.pushRest("devices.installation");
  };
  const total = pinned.downloadBytes;
  await push({ progress: { component: "platformTools", received: 8388608, total } });
  await expect(install.getByRole("status")).toHaveText(
    "Downloading the platform tools: 8 MB of 2.2 GB",
  );
  await push({ progress: { component: "image", received: 1288490189, total } });
  await expect(install.getByRole("status")).toHaveText(
    "Downloading the system image: 1.2 GB of 2.2 GB",
  );
  await expect(
    install.getByRole("button", { name: "Cancel installation" }),
  ).toBeEnabled();
  await shoot(page, "installing");
  await push({
    state: "unpacking",
    progress: { component: "image", received: total, total },
  });
  await expect(install.locator(".list-row-status")).toHaveText("Unpacking");
  await expect(install.getByRole("status")).toHaveText("Unpacking the system image");
  await push({
    state: "checking",
    progress: { component: "emulator", received: total, total },
  });
  await expect(install.getByRole("status")).toHaveText("Checking the emulator");
  state.installation = installed();
  state.view = view([]);
  await liveStub.pushRest("devices.installation");
  await liveStub.pushRest("devices");
  await expect(install.locator(".list-row-status")).toHaveText("Installed");
  await expect(install).toContainText(
    "Emulator 37.3.10, platform tools 37.0.3, system image android-36-google_apis-r7",
  );
  await expect(install.getByRole("status")).toHaveCount(0);
  await expect(group(page, "Devices")).toContainText("No devices yet.");
  await expect(page.getByRole("button", { name: "+ New device" })).toBeEnabled();
  expect(requests).toEqual([]);
});

test("a failed installation says why; a refused one keeps the dialog open", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, {
    status: installation({
      state: "failed",
      failure: {
        code: "DEVICES_SDK_UNUSABLE",
        at: 5,
        detail: { missing: ["libX11.so.6", "libX11-xcb.so.1"] },
      },
    }),
    shown: notInstalledView(),
  });
  await open(page);
  const install = group(page, "Installation");
  await expect(install.locator(".list-row-status")).toHaveText("Failed");
  await expect(install.getByRole("alert")).toContainText(
    "these system libraries are missing: libX11.so.6, libX11-xcb.so.1.",
  );
  await install.getByRole("button", { name: "Try again …" }).click();
  const dialog = page.getByRole("dialog", { name: "Install Android devices?" });
  state.next = refusal("DEVICES_OPERATION_RUNNING");
  await dialog.getByRole("button", { name: "Accept and install" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The Android components are being installed, updated or removed. Wait until that is done.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A failed update shows beside the installation that stays in use.
  state.installation = installed({
    failure: { code: "DEVICES_DOWNLOAD_STALLED", at: 9 },
  });
  state.view = view([device()]);
  await liveStub.pushRest("devices.installation");
  await liveStub.pushRest("devices");
  await expect(install.locator(".list-row-status")).toHaveText("Installed");
  await expect(install.getByRole("alert")).toContainText(
    "The update to the current versions failed, and the installed versions stay in use.",
  );
  await expect(install.getByRole("alert")).toContainText("stopped making progress");
  await expect(install.getByRole("button", { name: "Try again …" })).toBeEnabled();
});

test("a download is cancelled without a question, once", async ({ page }) => {
  const state = await setup(page, {
    status: installation({
      state: "downloading",
      progress: {
        component: "emulator",
        received: 104857600,
        total: pinned.downloadBytes,
      },
    }),
    shown: notInstalledView(),
  });
  await open(page);
  const install = group(page, "Installation");
  const cancel = install.getByRole("button", { name: "Cancel installation" });
  const request = held(state);
  await cancel.click();
  await expect(cancel).toBeDisabled();
  await expect(cancel).toContainText("In progress");
  request.answer();
  await expect(install.locator(".list-row-status")).toHaveText("Not installed");
  expect(state.requests).toEqual([
    { method: "POST", path: "/installation/cancel", body: null },
  ]);
});

test("a device goes from Starting to Running on a push, without a request", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, {
    devices: [
      device(),
      device({ id: "d-0000000000b2", name: "Shop login", state: "running" }),
    ],
  });
  await open(page);
  const pixel = row(page, "Pixel test");
  await expect(pixel.locator(".list-row-status")).toHaveText("Stopped");
  await expect(pixel).toContainText("Created by you · 3.8 GB on disk");
  await expect(row(page, "Shop login").locator(".list-row-status")).toHaveText("Running");
  await expect(group(page, "Devices")).toContainText("2 of 5 devices, 1 of 2 running");
  await shoot(page, "list");

  // The start answers when the device holds its slot; until then the button waits
  // and a second click sends nothing.
  const request = held(state);
  const start = pixel.getByRole("button", { name: "Start Pixel test" });
  await start.click();
  await expect(start).toBeDisabled();
  await expect(start).toHaveText("One moment …");
  await expect(pixel.getByRole("button", { name: "Delete Pixel test …" })).toBeDisabled();
  await start.click({ force: true });
  request.answer();
  await expect(pixel.locator(".list-row-status")).toHaveText("Starting");
  expect(sent(state, "POST", "/d-0000000000a1/start")).toHaveLength(1);
  const stop = pixel.getByRole("button", { name: "Stop Pixel test" });
  await expect(stop).toBeEnabled();
  await expect(start).toHaveCount(0);

  const requests = appRequests(page);
  state.change("d-0000000000a1", { state: "running", lastUsedAt: 1795000001000 });
  await liveStub.pushRest("devices");
  await expect(pixel.locator(".list-row-status")).toHaveText("Running");
  await expect(group(page, "Devices")).toContainText("2 of 5 devices, 2 of 2 running");
  expect(requests).toEqual([]);

  // Stop answers at once; the stopped device follows as a push.
  await stop.click();
  await expect(pixel.locator(".list-row-status")).toHaveText("Stopping");
  await expect(stop).toBeDisabled();
  state.change("d-0000000000a1", { state: "stopped" });
  await liveStub.pushRest("devices");
  await expect(pixel.locator(".list-row-status")).toHaveText("Stopped");
  await expect(start).toBeEnabled();
});

test("a failed device shows its reason; a refused start says why", async ({ page }) => {
  const state = await setup(page, {
    devices: [
      device({ state: "failed", failure: { code: "DEVICE_PORTS_BUSY", at: 9 } }),
      device({ id: "d-0000000000b2", name: "Shop login" }),
      device({
        id: "d-0000000000c3",
        name: "Old image",
        image: { id: "android-35-google_apis-r9", current: false },
        creator: { kind: "session", id: "s1", name: "web checkout", gone: true },
        assignments: [{ kind: "agent", id: "a1", name: "Tester", manage: true }],
      }),
    ],
  });
  await open(page);
  const pixel = row(page, "Pixel test");
  await expect(pixel.locator(".list-row-status")).toHaveText("Failed");
  await expect(pixel.getByRole("alert")).toHaveText(
    "AgentPier's ports for devices (47600 to 47621 on this computer) are in use by another program. Close that program, then start the device again.",
  );
  await expect(pixel.getByRole("button", { name: "Start Pixel test" })).toBeEnabled();

  const shop = row(page, "Shop login");
  state.next = refusal("DEVICE_LIMIT_RUNNING");
  await shop.getByRole("button", { name: "Start Shop login" }).click();
  await expect(shop.getByRole("alert")).toHaveText(
    "The limit of devices running at once is reached and every running device is in use. Stop a device or raise the limit.",
  );
  await expect(shop.locator(".list-row-status")).toHaveText("Stopped");
  // The reason of an unavailable device is what the owner reads.
  state.next = refusal("DEVICE_UNAVAILABLE", { reason: "DEVICES_OPERATION_RUNNING" });
  await shop.getByRole("button", { name: "Start Shop login" }).click();
  await expect(shop.getByRole("alert")).toContainText(
    "being installed, updated or removed",
  );

  // Creator, assignments and what an earlier image means are part of the row.
  const old = row(page, "Old image");
  await expect(old).toContainText(
    "Created by session web checkout (creator no longer exists)",
  );
  await expect(old).toContainText("Assigned to Tester (may reset and delete)");
  await expect(old).toContainText(
    "This device uses an earlier system image. It still starts; a reset moves it to the current image.",
  );
});

test("reset and delete ask first and wait for the server", async ({ page }) => {
  const state = await setup(page, {
    devices: [device(), device({ id: "d-0000000000b2", name: "Shop login" })],
  });
  await open(page);
  const pixel = row(page, "Pixel test");
  await pixel.getByRole("button", { name: "Delete Pixel test …" }).click();
  const remove = page.getByRole("dialog", { name: "Delete device “Pixel test”?" });
  await expect(remove).toContainText("The device and everything on it are deleted");
  await expect(remove.getByRole("button", { name: "Cancel" })).toBeFocused();
  await remove.getByRole("button", { name: "Cancel" }).click();
  await expect(remove).toHaveCount(0);
  expect(state.requests).toEqual([]);
  await expect(pixel).toBeVisible();

  // A refusal stays in the dialog.
  await pixel.getByRole("button", { name: "Delete Pixel test …" }).click();
  state.next = refusal("DEVICE_STOP_FAILED");
  await remove.getByRole("button", { name: "Delete now" }).click();
  await expect(remove.getByRole("alert")).toContainText("The device did not stop.");
  const request = held(state);
  const confirm = remove.getByRole("button", { name: "Delete now" });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  request.answer();
  await expect(remove).toHaveCount(0);
  await expect(pixel).toHaveCount(0);
  expect(sent(state, "DELETE", "/d-0000000000a1")).toHaveLength(2);
  await expect(group(page, "Devices")).toContainText("1 of 5 devices, 0 of 2 running");

  const shop = row(page, "Shop login");
  await shop.getByRole("button", { name: "Reset Shop login …" }).click();
  const reset = page.getByRole("dialog", { name: "Reset device “Shop login”?" });
  await expect(reset).toContainText("goes back to its factory state");
  await reset.getByRole("button", { name: "Reset now" }).click();
  await expect(reset).toHaveCount(0);
  expect(sent(state, "POST", "/d-0000000000b2/reset")).toHaveLength(1);
  await expect(shop).toBeVisible();
});

test("a new device is created by name, from the page and from the search", async ({
  page,
}) => {
  const state = await setup(page, { devices: [device()] });
  await open(page);
  await page.getByRole("button", { name: "+ New device" }).click();
  const dialog = page.getByRole("dialog", { name: "New device" });
  const name = dialog.getByLabel("Name");
  await name.fill("Pixel test");
  state.next = refusal("DEVICE_NAME_TAKEN");
  await dialog.getByRole("button", { name: "Create device" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Another device already has this name. Choose a different one.",
  );
  // The typed name stays for the correction.
  await expect(name).toHaveValue("Pixel test");
  await name.fill("  Checkout phone ");
  await dialog.getByRole("button", { name: "Create device" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent(state, "POST", "").map((entry) => entry.body)).toEqual([
    { name: "Pixel test" },
    { name: "Checkout phone" },
  ]);
  await expect(row(page, "Checkout phone").locator(".list-row-status")).toHaveText(
    "Stopped",
  );

  // ⌘K "New device" opens the dialog, from another page too.
  // The search also reads the owner's lists while it is open; none are needed here.
  await page.route(
    /\/api\/(pipelines|pipeline-profiles|projects|views|connections)\b/,
    (route) => route.fulfill({ status: 404, json: { error: "Not in this fixture" } }),
  );
  await page.goto(baseURL + "/settings");
  await page
    .getByRole("button", { name: /^Search/ })
    .first()
    .click();
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox").fill("new device");
  await search.getByRole("option", { name: /New device/ }).click();
  await expect(page).toHaveURL(/\/settings\/devices$/);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // At the limit the button is off and says why.
  state.view = { ...state.view, settings: { maxDevices: 2, maxRunning: 2 } };
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New device" })).toBeDisabled();
  await expect(group(page, "Devices")).toContainText(
    "The limit of 2 devices is reached. Delete a device or raise the limit below.",
  );
});

test("the limits are a draft with a save bar", async ({ page }) => {
  const state = await setup(page, { devices: [device()] });
  await open(page);
  const limits = group(page, "Limits");
  const total = limits.getByRole("spinbutton", { name: "Devices in total" });
  const running = limits.getByRole("spinbutton", { name: "Devices running at once" });
  await expect(total).toHaveValue("5");
  await expect(running).toHaveValue("2");
  await expect(limits).toContainText("stops by itself after 15 minutes without use");
  await expect(settingsBar(page)).toHaveCount(0);
  await total.fill("40");
  const save = settingsBar(page).getByRole("button", { name: "Save limits" });
  await save.click();
  await expect(settingsBar(page).getByRole("alert")).toHaveText(
    "Enter 1 to 20 devices in total and 1 to 5 running at once.",
  );
  expect(state.requests).toEqual([]);
  await total.fill("8");
  await running.fill("3");
  await save.click();
  await expect(settingsBar(page)).toHaveCount(0);
  expect(state.requests).toEqual([
    { method: "PUT", path: "/settings", body: { maxDevices: 8, maxRunning: 3 } },
  ]);
  await expect(group(page, "Devices")).toContainText("1 of 8 devices, 0 of 3 running");
  await expect(total).toHaveValue("8");
});

test("uninstalling names the devices it deletes and waits while one runs", async ({
  page,
  liveStub,
}) => {
  const state = await setup(page, {
    devices: [
      device(),
      device({ id: "d-0000000000b2", name: "Shop login", state: "running" }),
    ],
  });
  await open(page);
  const install = group(page, "Installation");
  const uninstall = install.getByRole("button", { name: "Uninstall …" });
  await expect(uninstall).toBeDisabled();
  await expect(uninstall).toContainText("Stop every device first.");
  state.change("d-0000000000b2", { state: "stopped" });
  await liveStub.pushRest("devices");
  await expect(uninstall).toBeEnabled();
  await uninstall.click();
  const dialog = page.getByRole("dialog", { name: "Uninstall Android devices?" });
  await expect(dialog).toContainText(
    "This deletes the Android components and your 2 devices with everything on them",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // A device that started meanwhile refuses it; nothing is deleted.
  state.next = refusal("DEVICES_IN_USE");
  await dialog.getByRole("button", { name: "Uninstall" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "A device is starting, running or stopping. Stop every device first.",
  );
  await dialog.getByRole("button", { name: "Uninstall" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent(state, "POST", "/installation/remove")).toHaveLength(2);
  await expect(install.locator(".list-row-status")).toHaveText("Uninstalling");
  await expect(install.getByRole("status")).toHaveText(
    "Deleting the devices and the Android components",
  );
  await expect(install.getByRole("button")).toHaveCount(0);
  state.installation = installation();
  await liveStub.pushRest("devices.installation");
  await expect(install.locator(".list-row-status")).toHaveText("Not installed");
});

test("Settings › General links the page with the installation's state", async ({
  page,
}) => {
  const state = await setup(page, { devices: [device()] });
  await page.goto(baseURL + "/settings");
  const link = settingsRow(page, "Android devices");
  await expect(link).toHaveAttribute("href", "/settings/devices");
  await expect(link).toContainText("Emulated Android phones for agents and sessions.");
  await expect(link).toContainText("Installed");
  await link.click();
  await expect(page).toHaveURL(/\/settings\/devices$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Android devices");
  // Back leads to the General tab.
  await page.getByRole("button", { name: "Back to General" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(state.requests).toEqual([]);
});

test.describe("in German", () => {
  test.use({ locale: "de-DE" });
  test("the page reads in German", async ({ page }) => {
    await setup(page, {
      devices: [device({ state: "failed", failure: { code: "DEVICE_EXITED", at: 1 } })],
    });
    await open(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Android-Geräte");
    const install = group(page, "Installation");
    await expect(install.locator(".list-row-status")).toHaveText("Installiert");
    await expect(install.getByRole("button", { name: "Deinstallieren …" })).toBeEnabled();
    const pixel = row(page, "Pixel test");
    await expect(pixel.locator(".list-row-status")).toHaveText("Fehlgeschlagen");
    await expect(pixel.getByRole("alert")).toContainText(
      "Der Emulator wurde unerwartet beendet.",
    );
    await expect(pixel).toContainText("Von dir angelegt");
    await expect(
      pixel.getByRole("button", { name: "Pixel test löschen …" }),
    ).toBeEnabled();
    await expect(group(page, "Limits")).toContainText("Gleichzeitig laufende Geräte");
    await expect(group(page, "Geräte")).toContainText("1 von 5 Geräten, 0 von 2 laufen");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("rows wrap, actions are reachable and dialogs are sheets", async ({ page }) => {
    await setup(page, {
      devices: [
        device({ name: "A device with quite a long name for a narrow screen" }),
        device({
          id: "d-0000000000b2",
          name: "Shop login",
          state: "running",
          creator: { kind: "agent", id: "a1", name: "Checkout tester", gone: false },
          assignments: [
            { kind: "agent", id: "a1", name: "Checkout tester", manage: true },
          ],
        }),
      ],
    });
    await open(page);
    const shop = row(page, "Shop login");
    await expect(shop.locator(".list-row-status")).toHaveText("Running");
    // Nothing is wider than the screen.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    // Every action of every device is inside the screen and a full touch target.
    const buttons = page.locator(".device-row-actions .button");
    await expect(buttons).toHaveCount(6);
    for (const button of await buttons.all()) {
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    for (const control of await group(page, "Installation").getByRole("button").all())
      expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot(page, "phone");

    // The confirmation is a bottom sheet with the action on top.
    await shop.getByRole("button", { name: "Delete Shop login …" }).tap();
    const dialog = page.getByRole("dialog", { name: "Delete device “Shop login”?" });
    await expect(dialog).toBeVisible();
    const sheet = await dialog.boundingBox();
    expect(Math.round(sheet.y + sheet.height)).toBe(844);
    expect(Math.round(sheet.width)).toBe(390);
    const confirm = await dialog
      .getByRole("button", { name: "Delete now" })
      .boundingBox();
    const cancel = await dialog.getByRole("button", { name: "Cancel" }).boundingBox();
    expect(confirm.height).toBeGreaterThanOrEqual(44);
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(844);
    expect(cancel.y + cancel.height).toBeLessThanOrEqual(844);
    await shoot(page, "phone-sheet");
    await dialog.getByRole("button", { name: "Cancel" }).tap();
    await expect(dialog).toHaveCount(0);

    // So is the form for a new device, with its field and both buttons on screen.
    await page.getByRole("button", { name: "+ New device" }).tap();
    const create = page.getByRole("dialog", { name: "New device" });
    const form = await create.boundingBox();
    expect(Math.round(form.y + form.height)).toBe(844);
    await expect(create.getByLabel("Name")).toBeVisible();
    const submit = await create
      .getByRole("button", { name: "Create device" })
      .boundingBox();
    expect(submit.y + submit.height).toBeLessThanOrEqual(844);
  });
});
