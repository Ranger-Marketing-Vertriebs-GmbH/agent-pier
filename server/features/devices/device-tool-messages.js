/*
 * What a device tool tells its caller when it refuses: one English sentence per
 * stable code that says what happened and what to do next. Coding agents read
 * English; the owner's texts for the same codes are in the web catalogs
 * (web/lib/i18n/<language>/devices.js).
 *
 * The same refusals reach a coding session (device-mcp.js) and an agent
 * (assistants/agent-devices.js); only the words for the caller and its tools differ
 * (AUDIENCES): a session has one tool per action, an agent one tool with an action.
 */
const call = (action) => `agentpier_device (action ${action})`;
/** What a sentence names per kind of caller. */
export const AUDIENCES = Object.freeze({
  session: Object.freeze({
    caller: "this session",
    list: "devices_list",
    start: "device_start",
    ui: "device_ui",
    key: "device_key",
    shell: "device_shell",
    folder: "your own working folder (a session's project folder or worktree)",
    eligible:
      "Android devices are available to the owner's own interactive coding sessions only.",
  }),
  agent: Object.freeze({
    caller: "this agent",
    list: call("list"),
    start: call("start"),
    ui: call("ui"),
    key: call("key"),
    shell: call("shell"),
    folder: "your own workspace",
    eligible:
      "Android devices are available to the owner's own agents only: not to an agent of restricted users and not to an agent with its own Telegram bot for other people.",
  }),
});

const sentences = (w) => ({
  DEVICE_NOT_FOUND: `There is no such device. Call ${w.list} for the devices you may use.`,
  DEVICE_FORBIDDEN: `This device is not assigned to ${w.caller}, or the owner did not allow this action on it. Ask the owner to assign it in AgentPier (and to allow reset and delete, if that is what you need).`,
  DEVICE_CREATE_FORBIDDEN: `${w.caller[0].toUpperCase()}${w.caller.slice(1)} may not create devices. Ask the owner to allow it for ${w.caller} in AgentPier, or to assign an existing device.`,
  DEVICE_SESSION_INELIGIBLE: AUDIENCES.session.eligible,
  DEVICE_AGENT_INELIGIBLE: AUDIENCES.agent.eligible,
  DEVICE_RUN_FORBIDDEN:
    "Android devices are not available in this run: it works on content that is not the owner's own (a forwarded message, another person's or a member's message), or AgentPier cannot tell how the run started. Do not retry; tell the owner.",
  DEVICE_OWNER_TURN_REQUIRED:
    "Creating, resetting and deleting a device is possible only in a turn the owner started with a message of their own, not in a routine, a hook, a follow-up run or a delegated task. Do not retry; ask the owner to say so in the chat.",
  DEVICE_PULL_READONLY: `This run may not change files in the workspace, so a file cannot be copied from a device into it. Read the content with ${w.shell} (cat) instead.`,
  DEVICE_PASS_INVALID: `You can pass on only devices that are assigned to you or that you created, by their id or name from ${w.list}, and only while Android devices are available to you in this run.`,
  DEVICE_HELD:
    "The owner is using this device right now. Wait until they hand it back, then try again.",
  DEVICE_BUSY:
    "The device is being reset or deleted, or is stopping. Try again in a moment.",
  DEVICE_NOT_RUNNING: `The device is not running. Start it with ${w.start}.`,
  DEVICE_NAME_INVALID: "A device name has 1 to 40 characters.",
  DEVICE_NAME_TAKEN: "Another device already has this name. Choose a different one.",
  DEVICE_LIMIT_TOTAL:
    "The owner's limit of devices is reached. Delete a device of your own, or ask the owner.",
  DEVICE_LIMIT_RUNNING:
    "The limit of devices running at once is reached and every running device is in use. Stop a device you no longer need, or try again later.",
  DEVICE_UNAVAILABLE:
    "Android devices are not available on this host right now (not installed, being updated, or AgentPier is stopping).",
  DEVICE_IMAGE_MISSING:
    "The system image this device needs is not installed. The owner has to update the Android components in AgentPier.",
  DEVICE_DISK_SPACE:
    "There is too little free disk space on the host for another device.",
  DEVICE_INPUT_INVALID: "An argument is missing or malformed.",
  DEVICE_TEXT_UNSUPPORTED: `Only printable ASCII characters (space to ~) can be typed in this version: no umlauts, accents, emoji, tabs or line breaks. Type the ASCII parts and press keys such as enter with ${w.key}.`,
  DEVICE_ELEMENT_STALE: `This element number is not from a current overview of this device: none was taken yet, the number is not in it, or the device was restarted or reset since. Call ${w.ui} again and use a number from its result.`,
  DEVICE_PATH_OUTSIDE: `The path on the host must lie inside ${w.folder}, and must not be a link out of it or a file with several names.`,
  DEVICE_PULL_SANDBOXED: `A sandboxed session cannot copy files from a device into its working folder: AgentPier runs outside the sandbox and cannot tell whether the sandbox lets this session write there. Read the content with ${w.shell} (cat) and write the file yourself.`,
  DEVICE_FILE_NOT_FOUND: "There is no regular file at that path.",
  DEVICE_FILE_TOO_LARGE: "The file is larger than the limit for this action.",
  DEVICE_COMMAND_FAILED: "The device refused this.",
  DEVICE_SCREEN_UNAVAILABLE:
    "The device did not deliver its screen. Wait a moment and try again; a screen that keeps animating can block the overview.",
  DEVICE_CALL_TIMEOUT:
    "The call took too long and was ended. If the device was still starting, it goes on booting: try again in a moment.",
  DEVICE_ADB_TIMEOUT: "The device did not answer within the time limit of this call.",
  DEVICE_ADB_FAILED:
    "AgentPier could not reach the device through adb. Stop the device and start it again.",
  DEVICE_ADB_CANCELLED: "The call was cancelled.",
  DEVICE_BOOT_TIMEOUT:
    "The device did not finish booting. Start it again; if it keeps failing, it needs a reset.",
  DEVICE_EXITED: "The emulator ended unexpectedly. Start the device again.",
  DEVICE_PORTS_BUSY:
    "The host's ports for devices are in use by another program. The owner has to free them.",
  DEVICE_START_FAILED: "The device could not be started. Try again.",
  DEVICE_START_CANCELLED: "The start was cancelled because the device was stopped.",
  DEVICE_STOP_FAILED: "The device did not stop. Try again.",
});
const byAudience = Object.fromEntries(
  Object.entries(AUDIENCES).map(([name, words]) => [name, sentences(words)]),
);
const messages = byAudience.session;

const megabytes = (bytes) => `${Math.round(bytes / 2 ** 20)} MB`;

/** Whether `code` is a stable code of the device feature. */
export const deviceCode = (code) =>
  typeof code === "string" && /^DEVICES?_[A-Z0-9_]+$/.test(code);

/**
 * The sentence for the refusal `error` (its `code`, and the `detail`, `limit` or
 * `reason` it carries), in the words of `audience` ("session" or "agent"). A code
 * without a sentence of its own names itself.
 */
export function deviceToolMessage(error, audience = "session") {
  const code = error?.code;
  const texts = Object.hasOwn(byAudience, audience) ? byAudience[audience] : messages;
  const known = Object.hasOwn(texts, code) ? texts[code] : null;
  const base =
    known ?? `The device call was refused (${deviceCode(code) ? code : "UNKNOWN"}).`;
  const extra = [
    typeof error?.limit === "number" && `The limit is ${megabytes(error.limit)}.`,
    typeof error?.detail === "string" && error.detail && `Detail: ${error.detail}`,
    deviceCode(error?.reason) && `Reason: ${error.reason}.`,
  ].filter(Boolean);
  return [base, ...extra].join(" ");
}

/** The codes that have a sentence of their own. */
export const messageCodes = Object.freeze(Object.keys(messages));
