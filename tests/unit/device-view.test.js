import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setLanguage, withLanguage } from "../../web/lib/i18n/index.js";
import {
  assignmentText,
  codeText,
  createBlocked,
  deviceRowView,
  featureState,
  installationView,
  readLimits,
  refusalText,
  validDevices,
  validInstallation,
} from "../../web/features/devices/device-view.js";
import { liveTopics } from "../../web/lib/live/live-topics.js";
import { AVAILABILITY_CODES } from "../../server/features/devices/device-availability.js";
import * as de from "../../web/lib/i18n/de/devices.js";
import * as en from "../../web/lib/i18n/en/devices.js";
import {
  device,
  installation,
  installed,
  notInstalledView,
  pinned,
  view,
} from "../helpers/devices-fixture.js";

// What Settings › General › Android devices shows of each state the server reports
// (device-view.js), in English.
setLanguage("en");
const bytes = (value) => `${(value / 2 ** 30).toFixed(1)} GB`;
const install = (patch, options) => installationView(installation(patch), bytes, options);
const kinds = (shown) => shown.actions.map((action) => action.kind);
const row = (patch, options = {}) =>
  deviceRowView(device(patch), {
    availability: { available: true, reason: null },
    installation: installed(),
    bytes,
    ...options,
  });

// Every code the server can send: each quoted DEVICE_* / DEVICES_* literal of the
// feature's sources and its routes, and the codes the shared download builds from its
// prefix. A new code without a text in both catalogs fails here.
function serverCodes() {
  const root = fileURLToPath(new URL("../../server/", import.meta.url));
  const files = [
    ...fs
      .readdirSync(path.join(root, "features/devices"))
      .map((name) => path.join(root, "features/devices", name)),
    path.join(root, "http/routes/devices.js"),
    path.join(root, "application/device-wiring.js"),
    // The agents' side of the feature: their tool, its gate and what a lead passes on.
    ...["agent-devices.js", "agent-device-origin.js", "member-device-passes.js"].map(
      (name) => path.join(root, "features/assistants", name),
    ),
  ];
  const codes = new Set();
  for (const file of files)
    for (const match of fs
      .readFileSync(file, "utf8")
      .matchAll(/["'`](DEVICES?_[A-Z0-9]+(?:_[A-Z0-9]+)*)["'`]/g))
      codes.add(match[1]);
  const download = fs.readFileSync(
    path.join(root, "features/tools/pinned-download.js"),
    "utf8",
  );
  for (const match of download.matchAll(/code\("([A-Z0-9_]+)"\)/g))
    codes.add(`DEVICES_${match[1]}`);
  return [...codes].sort();
}

test("every code the server can send has a text in both languages", () => {
  const codes = serverCodes();
  // The scan finds the codes of every layer (a moved file would empty it silently).
  for (const expected of [
    ...AVAILABILITY_CODES,
    "DEVICE_NOT_FOUND",
    "DEVICE_LIMIT_RUNNING",
    "DEVICE_PORTS_BUSY",
    "DEVICE_START_FAILED",
    "DEVICE_SOURCE",
    "DEVICES_NOT_INSTALLED",
    "DEVICES_SHUTTING_DOWN",
    "DEVICES_TERMS_REQUIRED",
    "DEVICES_SDK_UNUSABLE",
    "DEVICES_INTERRUPTED",
    "DEVICES_DOWNLOAD_FAILED",
    "DEVICES_DOWNLOAD_STALLED",
    "DEVICES_DOWNLOAD_CANCELLED",
    "DEVICES_CHECKSUM_MISMATCH",
    "DEVICE_AGENT_INELIGIBLE",
    "DEVICE_RUN_FORBIDDEN",
    "DEVICE_OWNER_TURN_REQUIRED",
    "DEVICE_PULL_READONLY",
    "DEVICE_PASS_INVALID",
  ])
    assert.ok(codes.includes(expected), expected);
  assert.ok(codes.length >= 40, String(codes.length));
  for (const [language, catalog] of [
    ["de", de.devicesCopy],
    ["en", en.devicesCopy],
  ])
    for (const code of codes) {
      const text = catalog.codes[code];
      assert.equal(typeof text, "string", `${language} ${code}`);
      // A sentence for the owner, never the code itself.
      assert.ok(text.length > 15 && /[.]$/.test(text), `${language} ${code}`);
      assert.doesNotMatch(text, /DEVICES?_[A-Z]/, `${language} ${code}`);
      assert.equal(
        withLanguage(language, () => codeText(code)),
        text,
      );
    }
  // No text is left for a code the server no longer sends.
  assert.deepEqual(Object.keys(en.devicesCopy.codes).sort(), codes);
  assert.deepEqual(Object.keys(de.devicesCopy.codes).sort(), codes);
});

test("codes say what the owner can do; an unknown code shows itself", () => {
  const denied = codeText("DEVICES_KVM_DENIED");
  const missing = codeText("DEVICES_KVM_MISSING");
  assert.notEqual(denied, missing);
  assert.match(denied, /kvm group/);
  assert.match(denied, /usermod -aG kvm/);
  assert.match(missing, /virtualization/);
  assert.doesNotMatch(missing, /group/);
  for (const language of ["de", "en"])
    withLanguage(language, () => {
      assert.match(codeText("DEVICES_KVM_DENIED"), /kvm/);
      // The fixed loopback ports, so the owner can look for what holds them.
      assert.match(codeText("DEVICE_PORTS_BUSY"), /47600 (to|bis) 47621/);
      const libraries = codeText("DEVICES_SDK_UNUSABLE", {
        missing: ["libX11.so.6", "libX11-xcb.so.1"],
      });
      assert.match(libraries, /libX11\.so\.6, libX11-xcb\.so\.1/);
      assert.notEqual(libraries, codeText("DEVICES_SDK_UNUSABLE"));
      // Without names, the usual packages are named.
      assert.match(codeText("DEVICES_SDK_UNUSABLE", { missing: [] }), /libx11-xcb1/);
      assert.match(codeText("DEVICES_SDK_UNUSABLE"), /libx11-6/);
    });
  // An unavailable device is explained by its reason.
  assert.equal(
    codeText("DEVICE_UNAVAILABLE", { reason: "DEVICES_OPERATION_RUNNING" }),
    codeText("DEVICES_OPERATION_RUNNING"),
  );
  assert.equal(
    codeText("DEVICE_UNAVAILABLE", { reason: "NEW_REASON" }),
    en.devicesCopy.codes.DEVICE_UNAVAILABLE,
  );
  assert.equal(codeText("DEVICE_NEW_CODE"), "Something went wrong (DEVICE_NEW_CODE).");
  assert.equal(codeText(undefined), "Something went wrong (UNKNOWN).");
  assert.equal(codeText("toString"), "Something went wrong (toString).");
  // A refused request: its code in words, with the detail the answer carried.
  assert.equal(
    refusalText({ code: "DEVICE_UNAVAILABLE", reason: "DEVICES_NOT_INSTALLED" }),
    "The Android components are not installed.",
  );
  assert.equal(refusalText({ message: "Request failed (500)" }), "Request failed (500)");
  assert.equal(
    refusalText({ code: "OTHER", message: "Something else" }),
    "Something else",
  );
});

test("absent offers the installation and names its size", () => {
  assert.deepEqual(install(), {
    tone: "idle",
    state: "Not installed",
    running: false,
    progress: "",
    versions: "",
    note: "",
    alert: "",
    actions: [
      {
        kind: "install",
        label: "Install …",
        hint: "Downloads 2.2 GB from Google after you confirm.",
        disabled: false,
      },
    ],
  });
  // The installer option left a request that the next start takes up.
  assert.match(install({ requested: true }).note, /requested by the installer/);
});

test("a host that cannot run devices says why and offers no installation", () => {
  for (const reason of AVAILABILITY_CODES) {
    const shown = install({ available: false, reason });
    assert.equal(shown.state, "Not available");
    assert.equal(shown.alert, codeText(reason));
    assert.deepEqual(shown.actions, []);
  }
  // What an earlier, usable host installed can still be removed.
  const left = installationView(
    installed({ available: false, reason: "DEVICES_KVM_DENIED" }),
    bytes,
  );
  assert.equal(left.state, "Not available");
  assert.match(left.alert, /kvm group/);
  assert.deepEqual(kinds(left), ["remove"]);
});

test("each step of a running installation is said, with cancel as the only action", () => {
  const total = pinned.downloadBytes;
  const first = install({ state: "downloading" });
  assert.equal(first.tone, "working");
  assert.equal(first.state, "Downloading");
  assert.equal(first.running, true);
  assert.equal(first.progress, "Starting the download");
  assert.deepEqual(kinds(first), ["cancel"]);
  assert.equal(
    install({
      state: "downloading",
      progress: { component: "emulator", received: 2 ** 29, total },
    }).progress,
    "Downloading the emulator: 0.5 GB of 2.2 GB",
  );
  assert.equal(
    install({
      state: "unpacking",
      progress: { component: "platformTools", received: 1, total },
    }).progress,
    "Unpacking the platform tools",
  );
  const checking = install({
    state: "checking",
    progress: { component: "image", received: total, total },
  });
  assert.equal(checking.state, "Checking");
  assert.equal(checking.progress, "Checking the system image");
  // An update of an installed SDK says that devices wait for it.
  const updating = installationView(
    installed({
      state: "downloading",
      updating: true,
      progress: { component: "emulator", received: 0, total },
    }),
    bytes,
  );
  assert.match(updating.note, /newer version is being installed/);
  assert.match(updating.versions, /Emulator 37\.3\.10/);
  assert.deepEqual(kinds(updating), ["cancel"]);
  const removing = install({ state: "removing" });
  assert.equal(removing.state, "Uninstalling");
  assert.equal(removing.tone, "working");
  assert.equal(removing.progress, "Deleting the devices and the Android components");
  assert.deepEqual(removing.actions, []);
});

test("installed names the versions and offers the removal unless a device runs", () => {
  const shown = installationView(installed(), bytes);
  assert.equal(shown.tone, "ok");
  assert.equal(shown.state, "Installed");
  assert.equal(
    shown.versions,
    "Emulator 37.3.10, platform tools 37.0.3, system image android-36-google_apis-r7",
  );
  assert.deepEqual(shown.actions, [
    {
      kind: "remove",
      label: "Uninstall …",
      hint: "Deletes the Android components and every device.",
      disabled: false,
    },
  ]);
  const inUse = installationView(installed(), bytes, { running: 1 });
  assert.deepEqual(inUse.actions, [
    {
      kind: "remove",
      label: "Uninstall …",
      hint: "Stop every device first.",
      disabled: true,
    },
  ]);
});

test("a failed update shows beside the installation that stays in use", () => {
  const shown = installationView(
    installed({ failure: { code: "DEVICES_DOWNLOAD_FAILED", at: 5 } }),
    bytes,
  );
  assert.equal(shown.state, "Installed");
  assert.equal(shown.tone, "warn");
  assert.match(shown.alert, /^The update to the current versions failed/);
  assert.match(shown.alert, /download from Google failed/);
  assert.deepEqual(kinds(shown), ["retry", "remove"]);
  // A later pin without a failure offers the update.
  const stale = installationView(
    installed({
      installed: { emulator: "36.1.9", platformTools: "37.0.3", images: ["android-35"] },
    }),
    bytes,
  );
  assert.equal(stale.alert, "");
  assert.match(stale.note, /newer components/);
  assert.deepEqual(
    stale.actions.map(({ kind, label }) => [kind, label]),
    [
      ["install", "Update …"],
      ["remove", "Uninstall …"],
    ],
  );
});

test("a failed installation says why and offers another attempt", () => {
  const shown = install({
    state: "failed",
    failure: {
      code: "DEVICES_SDK_UNUSABLE",
      at: 5,
      detail: { missing: ["libX11-xcb.so.1"] },
    },
    installed: { emulator: null, platformTools: "37.0.3", images: [] },
  });
  assert.equal(shown.tone, "error");
  assert.equal(shown.state, "Failed");
  assert.match(shown.alert, /libraries are missing: libX11-xcb\.so\.1\./);
  assert.match(shown.versions, /Emulator not installed, platform tools 37\.0\.3/);
  assert.deepEqual(kinds(shown), ["retry", "remove"]);
  assert.match(
    install({ state: "failed", failure: { code: "DEVICES_INTERRUPTED", at: 1 } }).alert,
    /stopped during the installation/,
  );
});

test("the settings row names the installation in one word", () => {
  assert.deepEqual(featureState(installation()), { tone: "idle", text: "Not installed" });
  assert.deepEqual(featureState(installed()), { tone: "ok", text: "Installed" });
  assert.deepEqual(featureState(installation({ state: "unpacking" })), {
    tone: "working",
    text: "Installing",
  });
  assert.deepEqual(featureState(installation({ state: "failed" })), {
    tone: "error",
    text: "Failed",
  });
  assert.deepEqual(
    featureState(installation({ available: false, reason: "DEVICES_KVM_MISSING" })),
    { tone: "idle", text: "Not available" },
  );
});

test("a stopped device can start, be reset and be deleted", () => {
  assert.deepEqual(row(), {
    tone: "idle",
    stateText: "Stopped",
    sub: "Created by you · 3.8 GB on disk",
    details: ["Created by you", "3.8 GB on disk"],
    note: "",
    alert: "",
    actions: [
      {
        kind: "start",
        label: "Start",
        name: "Start Pixel test",
        disabled: false,
        hint: "",
      },
      {
        kind: "reset",
        label: "Reset …",
        name: "Reset Pixel test …",
        disabled: false,
        hint: "",
      },
      {
        kind: "delete",
        label: "Delete …",
        name: "Delete Pixel test …",
        disabled: false,
        hint: "",
      },
    ],
  });
  // A size that is not measured yet is left out, never shown as 0.
  assert.equal(row({ diskBytes: null }).sub, "Created by you");
});

test("starting, running and stopping devices offer the stop", () => {
  const starting = row({ state: "starting" });
  assert.equal(starting.tone, "working");
  assert.equal(starting.stateText, "Starting");
  assert.deepEqual(kinds(starting), ["stop", "reset", "delete"]);
  assert.equal(starting.actions[0].disabled, false);
  const running = row({ state: "running" });
  // Its size was measured before it started and is not shown while it runs.
  assert.equal(running.sub, "Created by you");
  assert.equal(running.tone, "ok");
  assert.equal(running.stateText, "Running");
  assert.deepEqual(kinds(running), ["stop", "reset", "delete"]);
  const stopping = row({ state: "stopping" });
  assert.equal(stopping.stateText, "Stopping");
  assert.deepEqual(
    stopping.actions.map(({ kind, disabled }) => [kind, disabled]),
    [
      ["stop", true],
      ["reset", false],
      ["delete", false],
    ],
  );
});

test("a failed device shows its reason and can start again", () => {
  const failed = row({
    state: "failed",
    failure: { code: "DEVICE_BOOT_TIMEOUT", at: 9 },
  });
  assert.equal(failed.tone, "error");
  assert.equal(failed.stateText, "Failed");
  assert.match(failed.alert, /did not finish booting within 3 minutes/);
  assert.deepEqual(kinds(failed), ["start", "reset", "delete"]);
  // A failure without a code, or a state this build does not know, still reads.
  assert.equal(
    row({ state: "failed", failure: null }).alert,
    "Something went wrong (UNKNOWN).",
  );
  assert.equal(row({ state: "hibernating" }).stateText, "Failed");
});

test("a failed device whose process still lives offers the stop, not the start", () => {
  const stuck = row({
    state: "failed",
    live: true,
    failure: { code: "DEVICE_STOP_FAILED", at: 1 },
  });
  assert.equal(stuck.tone, "error");
  assert.match(stuck.alert, /did not stop\. Stop it again/);
  assert.deepEqual(kinds(stuck), ["stop", "reset", "delete"]);
  assert.deepEqual(
    stuck.actions.map((action) => action.disabled),
    [false, false, false],
  );
  assert.equal(stuck.actions[0].name, "Stop Pixel test");
  // Without a process there is nothing to stop.
  assert.deepEqual(
    kinds(
      row({ state: "failed", live: false, failure: { code: "DEVICE_EXITED", at: 1 } }),
    ),
    ["start", "reset", "delete"],
  );
});

test("a failure says what its reason names", () => {
  const foreign = row({
    state: "failed",
    failure: { code: "DEVICE_ADB_FAILED", at: 1, reason: "DEVICE_ADB_PORT_IN_USE" },
  });
  assert.match(
    foreign.alert,
    /port \(47600 on this computer\) is used by another program/,
  );
  assert.match(foreign.alert, /a second AgentPier/);
  assert.match(
    row({ state: "failed", failure: { code: "DEVICE_ADB_FAILED", at: 1 } }).alert,
    /could not reach the device through adb/,
  );
  // The refusal of a route says the same, in German as well.
  assert.equal(
    refusalText({ code: "DEVICE_ADB_FAILED", reason: "DEVICE_ADB_PORT_IN_USE" }),
    foreign.alert,
  );
  withLanguage("de", () =>
    assert.match(
      codeText("DEVICE_ADB_FAILED", { reason: "DEVICE_ADB_PORT_IN_USE" }),
      /zweites AgentPier/,
    ),
  );
  assert.match(
    row({
      state: "failed",
      failure: { code: "DEVICE_UNAVAILABLE", at: 1, reason: "DEVICES_NOT_INSTALLED" },
    }).alert,
    /components are not installed/,
  );
});

test("a reset or delete that runs locks the device's actions", () => {
  for (const [operation, text] of [
    ["reset", "Resetting"],
    ["delete", "Deleting"],
  ]) {
    const shown = row({ state: "stopped", operation });
    assert.equal(shown.tone, "working");
    assert.equal(shown.stateText, text);
    assert.ok(shown.actions.every((action) => action.disabled && action.hint === text));
  }
  // A failure is not repeated while the device is being reset.
  assert.equal(
    row({
      state: "failed",
      failure: { code: "DEVICE_EXITED", at: 1 },
      operation: "reset",
    }).alert,
    "",
  );
});

test("creator, assignments, hold and viewers are part of the row", () => {
  const agent = row({
    creator: { kind: "agent", id: "a1", name: "Tester", gone: false },
    assignments: [
      { kind: "agent", id: "a1", name: "Tester", manage: true },
      { kind: "session", id: "s1", name: "web checkout", manage: false },
    ],
    held: true,
    viewers: 2,
  });
  assert.deepEqual(agent.details, [
    "Created by agent Tester",
    "Assigned to agent Tester (may reset and delete), session web checkout",
    "3.8 GB on disk",
    "You are holding this device",
    "2 open views",
  ]);
  assert.equal(
    row({ creator: { kind: "session", id: "s1", name: "web checkout", gone: true } })
      .details[0],
    "Created by session web checkout (creator no longer exists)",
  );
  assert.equal(row({ viewers: 1 }).details.at(-1), "1 open view");
});

test("a row names three assignments and counts the rest", () => {
  const sessions = ["Checkout", "Login flow", "Settings", "Payments", "Search"].map(
    (name, index) => ({ kind: "session", id: `s${index}`, name, manage: index === 1 }),
  );
  assert.equal(assignmentText([]), "");
  assert.equal(assignmentText(undefined), "");
  assert.equal(
    assignmentText(sessions.slice(0, 3)),
    "Assigned to session Checkout, session Login flow (may reset and delete), session Settings",
  );
  assert.equal(
    assignmentText(sessions),
    "Assigned to session Checkout, session Login flow (may reset and delete), session Settings and 2 more",
  );
  assert.equal(
    row({ assignments: sessions }).details[1],
    "Assigned to session Checkout, session Login flow (may reset and delete), session Settings and 2 more",
  );
  // A session without a name shows its id; an empty entry is skipped.
  assert.equal(
    assignmentText([null, { kind: "session", id: "s9", name: "", manage: false }]),
    "Assigned to session s9",
  );
  withLanguage("de", () =>
    assert.equal(
      assignmentText(sessions),
      "Zugewiesen an Session Checkout, Session Login flow (darf zurücksetzen und löschen), Session Settings und 2 weitere",
    ),
  );
});

test("a row names agents and says when a lead passed the device on", () => {
  const home = { kind: "agent", id: "home", name: "Home", manage: true };
  const pass = {
    kind: "agent",
    id: "scout",
    name: "Scout",
    manage: false,
    passedBy: { id: "home", name: "Home" },
  };
  const session = { kind: "session", id: "s1", name: "Checkout", manage: false };
  assert.equal(
    assignmentText([home, pass, session]),
    "Assigned to agent Home (may reset and delete), agent Scout (passed on by Home for a task), session Checkout",
  );
  // A pass never resets or deletes, whatever the entry says, and a lead without a
  // name is still called the lead.
  assert.equal(
    assignmentText([{ ...pass, manage: true, passedBy: { id: "home", name: "" } }]),
    "Assigned to agent Scout (passed on by its lead agent for a task)",
  );
  // The cap of three names holds for agents and passes too.
  assert.equal(
    assignmentText([home, pass, session, { ...home, id: "ops", name: "Ops" }]),
    "Assigned to agent Home (may reset and delete), agent Scout (passed on by Home for a task), session Checkout and 1 more",
  );
  // An entry of a kind this build does not know keeps its plain name.
  assert.equal(
    assignmentText([{ kind: "team", id: "t1", name: "Crew" }]),
    "Assigned to Crew",
  );
  withLanguage("de", () => {
    assert.equal(
      assignmentText([home, pass]),
      "Zugewiesen an Agent Home (darf zurücksetzen und löschen), Agent Scout (von Home für eine Aufgabe weitergegeben)",
    );
    assert.equal(
      assignmentText([{ ...pass, passedBy: { id: "home", name: "" } }]),
      "Zugewiesen an Agent Scout (vom leitenden Agenten für eine Aufgabe weitergegeben)",
    );
  });
});

test("a creator that is gone is named, or described when it left no name", () => {
  const creator = (patch) =>
    row({ creator: { kind: "agent", id: "a1", name: "Tester", gone: true, ...patch } })
      .details[0];
  assert.equal(creator({}), "Created by agent Tester (creator no longer exists)");
  assert.equal(
    creator({ name: "", id: "" }),
    "Created by an agent that no longer exists",
  );
  assert.equal(
    creator({ kind: "session", name: "", id: "" }),
    "Created by a session that no longer exists",
  );
  // An agent that exists and has no name shows its id.
  assert.equal(creator({ name: "", gone: false }), "Created by agent a1");
  withLanguage("de", () => {
    assert.equal(
      creator({}),
      "Von Agent Tester angelegt (Ersteller existiert nicht mehr)",
    );
    assert.equal(
      creator({ name: "", id: "" }),
      "Von einem Agenten angelegt, den es nicht mehr gibt",
    );
  });
});

test("without a usable installation a device neither starts nor resets", () => {
  for (const reason of ["DEVICES_NOT_INSTALLED", "DEVICES_KVM_DENIED"]) {
    const shown = row({}, { availability: { available: false, reason } });
    assert.deepEqual(
      shown.actions.map(({ kind, disabled, hint }) => [kind, disabled, hint]),
      [
        ["start", true, codeText(reason)],
        ["reset", true, codeText(reason)],
        ["delete", false, ""],
      ],
    );
  }
});

test("a device on an earlier system image says what that means", () => {
  const earlier = { image: { id: "android-35-google_apis-r9", current: false } };
  const current = row(earlier);
  assert.match(current.note, /still starts; a reset moves it to the current image/);
  assert.ok(current.actions.every((action) => !action.disabled));
  // Until the pinned image is installed a reset would fail (DEVICE_IMAGE_MISSING).
  const behind = row(earlier, {
    installation: installed({
      installed: {
        emulator: "37.3.10",
        platformTools: "37.0.3",
        images: ["android-35-google_apis-r9"],
      },
    }),
  });
  assert.match(behind.note, /only be reset once the installation above is up to date/);
  assert.deepEqual(
    behind.actions.map(({ kind, disabled }) => [kind, disabled]),
    [
      ["start", false],
      ["reset", true],
      ["delete", false],
    ],
  );
  assert.equal(behind.actions[1].hint, behind.note);
});

test("a new device needs the installation and room below the limit", () => {
  assert.equal(createBlocked(view([device()])), "");
  assert.equal(
    createBlocked(notInstalledView()),
    "The Android components are not installed.",
  );
  const full = view([device(), device({ id: "d-0000000000a2", name: "Second" })], {
    settings: { maxDevices: 2, maxRunning: 2 },
  });
  assert.match(createBlocked(full), /limit of 2 devices is reached/);
});

test("limits are whole numbers within the server's bounds", () => {
  assert.deepEqual(readLimits({ maxDevices: 20, maxRunning: 5 }), {
    maxDevices: 20,
    maxRunning: 5,
  });
  for (const draft of [
    { maxDevices: 0, maxRunning: 2 },
    { maxDevices: 21, maxRunning: 2 },
    { maxDevices: 5, maxRunning: 6 },
    { maxDevices: 5, maxRunning: 0 },
    { maxDevices: "", maxRunning: 2 },
    { maxDevices: 2.5, maxRunning: 2 },
  ])
    assert.equal(readLimits(draft), null, JSON.stringify(draft));
});

test("values of another shape are not shown, and both topics have a route", () => {
  assert.equal(validInstallation(installation()), true);
  assert.equal(validInstallation(null), false);
  assert.equal(validInstallation({ state: "installed" }), false);
  assert.equal(validInstallation(installation({ state: "new-state" })), false);
  assert.equal(validDevices(view()), true);
  assert.equal(validDevices({ devices: [] }), false);
  assert.equal(validDevices(null), false);
  assert.equal(liveTopics.devices.path(), "/devices");
  assert.equal(liveTopics["devices.installation"].path(), "/devices/installation");
});
