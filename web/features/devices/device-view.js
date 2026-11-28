import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";

// What Settings › General › Android devices shows of the values the server reports:
// the installation (GET /api/devices/installation, live topic `devices.installation`)
// and the devices (GET /api/devices, live topic `devices`). Pure, so every state is
// tested without a browser.

const installationStates = [
  "absent",
  "downloading",
  "unpacking",
  "checking",
  "removing",
  "installed",
  "failed",
];
const deviceStates = ["stopped", "starting", "running", "stopping", "failed"];
const working = ["downloading", "unpacking", "checking", "removing"];

/** Whether `status` is an installation status this build can show. */
export const validInstallation = (status) =>
  !!status &&
  installationStates.includes(status.state) &&
  typeof status.available === "boolean" &&
  !!status.pinned?.image;

/** Whether `view` is a device view this build can show. */
export const validDevices = (view) =>
  !!view &&
  Array.isArray(view.devices) &&
  typeof view.availability?.available === "boolean" &&
  Number.isInteger(view.settings?.maxDevices);

/**
 * The text of a refusal or failure `code`, a known one in words that say what the
 * owner can do; an unknown code shows itself. `detail` is what came with the code:
 * `{ missing }` names the libraries of DEVICES_SDK_UNUSABLE, `{ reason }` says why
 * devices are unavailable (DEVICE_UNAVAILABLE) or why adb could not be used
 * (DEVICE_ADB_FAILED), and that reason's text is the answer.
 */
export function codeText(code, detail) {
  const known = (value) => typeof value === "string" && Object.hasOwn(copy.codes, value);
  if (code === "DEVICES_SDK_UNUSABLE") {
    const missing = (Array.isArray(detail?.missing) ? detail.missing : []).filter(
      (name) => typeof name === "string" && name,
    );
    if (missing.length) return copy.sdkMissingLibraries(missing.join(", "));
  }
  if (["DEVICE_UNAVAILABLE", "DEVICE_ADB_FAILED"].includes(code) && known(detail?.reason))
    return copy.codes[detail.reason];
  return known(code) ? copy.codes[code] : copy.unknownCode(String(code || "UNKNOWN"));
}

/** The text of a failed request: its code in words, else the request's own message. */
export const refusalText = (error) =>
  typeof error?.code === "string" && /^DEVICES?_/.test(error.code)
    ? codeText(error.code, error)
    : error?.message || copy.unknownCode("UNKNOWN");

// The installed components differ from the ones this AgentPier version pins.
const outdated = (status) =>
  !!status.installed &&
  (status.installed.emulator !== status.pinned.emulator ||
    status.installed.platformTools !== status.pinned.platformTools ||
    !status.installed.images?.includes(status.pinned.image.id));

/** Whether the system image a reset or a new device needs is installed. */
export const pinnedImageInstalled = (status) =>
  !!status?.installed?.images?.includes(status.pinned?.image?.id);

/**
 * The view of the installation `status`: `{ tone, state, running, progress, versions,
 * note, alert, actions }`. `tone` is a ListRow status tone; `progress` the running
 * step in words (`bytes(n)` formats a size; the byte counts cover every component of
 * the job); `versions` what is installed; `note` a plain remark; `alert` why the host
 * cannot run devices or what failed. `actions` are what the owner may do now, each
 * `{ kind: "install" | "retry" | "cancel" | "remove", label, hint, disabled }`.
 * `running` is how many devices hold a running slot: nothing is removed meanwhile.
 */
export function installationView(status, bytes, { running = 0 } = {}) {
  const { installation: text } = copy;
  const busy = working.includes(status.state);
  const { progress, failure, installed } = status;
  const download = bytes(status.pinned.downloadBytes || 0);
  const failed = failure?.code ? codeText(failure.code, failure.detail) : "";
  const component = text.components[progress?.component] ?? text.components.image;
  let step = "";
  if (status.state === "removing") step = text.removing;
  else if (busy && !progress) step = text.starting;
  else if (status.state === "downloading")
    step = text.downloading(
      component,
      bytes(progress.received || 0),
      bytes(progress.total || 0),
    );
  else if (busy) step = text[status.state](component);
  const remove = {
    kind: "remove",
    label: text.remove,
    hint: running > 0 ? text.removeBusyHint : text.removeHint,
    disabled: running > 0,
  };
  const install = { kind: "install", label: text.install, disabled: false };
  const retry = {
    kind: "retry",
    label: text.retry,
    hint: text.retryHint,
    disabled: false,
  };
  const base = {
    tone: "idle",
    state: text.states[status.state],
    running: busy,
    progress: step,
    versions: installed
      ? text.versions(
          installed.emulator ?? text.versionUnknown,
          installed.platformTools ?? text.versionUnknown,
          installed.images?.length ? installed.images.join(", ") : text.versionUnknown,
        )
      : "",
    note: "",
    alert: "",
    actions: [],
  };
  // A host that cannot run devices installs nothing; what is there can still go.
  if (!status.available)
    return {
      ...base,
      state: busy ? base.state : text.states.unavailable,
      tone: busy ? "working" : "idle",
      alert: codeText(status.reason),
      actions: installed && !busy ? [remove] : [],
    };
  if (status.state === "removing") return { ...base, tone: "working" };
  if (busy)
    return {
      ...base,
      tone: "working",
      note: status.updating ? text.updating : "",
      actions: [
        { kind: "cancel", label: text.cancel, hint: text.cancelHint, disabled: false },
      ],
    };
  if (status.state === "installed") {
    const stale = outdated(status);
    return {
      ...base,
      tone: failed || stale ? "warn" : "ok",
      // A failed update leaves the earlier installation in use: said beside it.
      alert: failed ? text.updateFailed(failed) : "",
      note: !failed && stale ? text.updatePending : "",
      actions: [
        ...(failed
          ? [retry]
          : stale
            ? [{ ...install, label: text.update, hint: text.updateHint }]
            : []),
        remove,
      ],
    };
  }
  if (status.state === "failed")
    return { ...base, tone: "error", alert: failed, actions: [retry, remove] };
  return {
    ...base,
    note: status.requested ? text.requested : "",
    actions: [{ ...install, hint: text.installHint(download) }],
  };
}

/** The installation in one word for the row on Settings › General: `{ tone, text }`. */
export function featureState(status) {
  const { featureStates: text } = copy;
  if (working.includes(status.state)) return { tone: "working", text: text.working };
  if (!status.available) return { tone: "idle", text: text.unavailable };
  if (status.state === "installed") return { tone: "ok", text: text.installed };
  if (status.state === "failed") return { tone: "error", text: text.failed };
  return { tone: "idle", text: text.absent };
}

const tones = {
  stopped: "idle",
  starting: "working",
  running: "ok",
  stopping: "working",
  failed: "error",
};
const operations = { reset: "resetting", delete: "deleting" };
// The states in which a device holds a running slot.
const slots = ["starting", "running", "stopping"];

// How many assignments a row names; the rest is a count, so a device many sessions
// share keeps a short row on a phone.
const namedAssignments = 3;

// One assignment in words: "agent Home", "session Deploy", with "may reset and
// delete" where set. A pass (`passedBy`, a lead's device a member uses for a task)
// names the lead instead; a pass never resets or deletes.
function assignmentName(entry) {
  const { list: text } = copy;
  const raw = String(entry.name || entry.id);
  const name =
    entry.kind === "agent"
      ? text.assignedAgent(raw)
      : entry.kind === "session"
        ? text.assignedSession(raw)
        : raw;
  if (entry.passedBy && typeof entry.passedBy === "object") {
    const lead = String(entry.passedBy.name || "");
    return lead ? text.assignedPassed(name, lead) : text.assignedPassedUnnamed(name);
  }
  return entry.manage ? text.assignedManage(name) : name;
}

/**
 * Who a device is assigned to, in one line, or "": the first three by kind and name
 * (an agent, a session; with "may reset and delete" where set, or that a lead passed
 * the device on for a task), then how many more.
 */
export function assignmentText(assignments) {
  const { list: text } = copy;
  const names = (Array.isArray(assignments) ? assignments : [])
    .filter((entry) => entry && (entry.name || entry.id))
    .map(assignmentName);
  if (!names.length) return "";
  const shown = names.slice(0, namedAssignments).join(", ");
  const more = names.length - namedAssignments;
  return more > 0 ? text.assignedMore(shown, more) : text.assigned(shown);
}

function creatorText(creator) {
  const { list: text } = copy;
  const name = String(creator?.name || creator?.id || "");
  // A creator that is gone and left no name: say so instead of an empty name.
  if (creator?.gone && !name && creator.kind === "agent") return text.creatorAgentGone;
  if (creator?.gone && !name && creator.kind === "session")
    return text.creatorSessionGone;
  const who =
    creator?.kind === "agent"
      ? text.creatorAgent(name)
      : creator?.kind === "session"
        ? text.creatorSession(name)
        : text.creatorOwner;
  return creator?.gone ? `${who} (${text.creatorGone})` : who;
}

/**
 * The view of one `device`: `{ tone, stateText, sub, details, note, alert, actions }`.
 * `details` are the lines under the name (creator, who it is assigned to, and for a
 * device that is not running its size on disk; `bytes(n)` formats the size) and `sub` the same in one line; `note` says what
 * an earlier system image means; `alert` is the failure in words. `actions` are
 * `{ kind: "start" | "stop" | "reset" | "delete", label, name, disabled, hint }`:
 * `name` labels the button for a screen reader, `hint` says why it is disabled. A
 * failed device whose process still lives (`device.live`, a stop that did not end
 * it) offers the stop again instead of a start, which could not work.
 * `availability` is the view's, `installation` the installation status (or null).
 */
export function deviceRowView(device, { availability, installation = null, bytes }) {
  const { list: text } = copy;
  const state = deviceStates.includes(device.state) ? device.state : "failed";
  const operation = Object.hasOwn(operations, device.operation ?? "")
    ? device.operation
    : null;
  const unavailable = availability?.available
    ? ""
    : codeText(availability?.reason || "DEVICE_UNAVAILABLE");
  const assigned = assignmentText(device.assignments);
  const details = [
    creatorText(device.creator),
    ...(assigned ? [assigned] : []),
    // The size is measured while a device is stopped: a device that runs has grown
    // since, so its last figure (a few kilobytes before the first start) is left out.
    ...(Number.isFinite(device.diskBytes) && bytes && !slots.includes(state)
      ? [text.size(bytes(device.diskBytes))]
      : []),
    ...(device.held ? [text.held] : []),
    ...(device.viewers > 0 ? [text.viewers(device.viewers)] : []),
  ];
  // A reset moves the device to the pinned image, which must be installed for it.
  const earlierImage = device.image?.current === false;
  const resetBlocked =
    earlierImage && !!installation && !pinnedImageInstalled(installation);
  const busy = operation ? text.states[operations[operation]] : "";
  const action = (kind, blocked = "") => ({
    kind,
    label: text[kind],
    name: text[`${kind}Named`](device.name),
    disabled: !!(busy || blocked),
    hint: busy || blocked,
  });
  const actions = [];
  const stuck = state === "failed" && device.live === true;
  if (["stopped", "failed"].includes(state) && !stuck)
    actions.push(action("start", unavailable));
  if (slots.includes(state) || stuck)
    actions.push(action("stop", state === "stopping" ? text.states.stopping : ""));
  actions.push(
    action("reset", unavailable || (resetBlocked ? text.imageOutdatedBlocked : "")),
    action("delete"),
  );
  return {
    tone: operation ? "working" : tones[state],
    stateText: operation ? text.states[operations[operation]] : text.states[state],
    sub: details.join(" · "),
    details,
    note: earlierImage
      ? resetBlocked
        ? text.imageOutdatedBlocked
        : text.imageOutdated
      : "",
    alert:
      state === "failed" && !operation
        ? codeText(device.failure?.code, device.failure)
        : "",
    actions,
  };
}

/** Why no device can be created now, or "": the host, the installation, the limit. */
export function createBlocked(view) {
  if (!view.availability.available)
    return codeText(view.availability.reason || "DEVICE_UNAVAILABLE");
  const { maxDevices } = view.settings;
  return view.devices.length >= maxDevices ? copy.list.createBlocked(maxDevices) : "";
}

/** The limits a draft holds, or null when they are out of range. */
export function readLimits({ maxDevices, maxRunning }) {
  const whole = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
  return whole(maxDevices, 20) && whole(maxRunning, 5)
    ? { maxDevices, maxRunning }
    : null;
}
