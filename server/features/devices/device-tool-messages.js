/*
 * What a device tool tells its caller when it refuses: one English sentence per
 * stable code that says what happened and what to do next. Coding agents read
 * English; the owner's texts for the same codes are in the web catalogs
 * (web/lib/i18n/<language>/devices.js).
 */
const messages = {
  DEVICE_NOT_FOUND:
    "There is no such device. Call devices_list for the devices you may use.",
  DEVICE_FORBIDDEN:
    "This device is not assigned to this session, or the owner did not allow this action on it. Ask the owner to assign it in AgentPier (and to allow reset and delete, if that is what you need).",
  DEVICE_CREATE_FORBIDDEN:
    "This session may not create devices. Ask the owner to allow it for this session in AgentPier, or to assign an existing device.",
  DEVICE_SESSION_INELIGIBLE:
    "Android devices are available to the owner's own interactive coding sessions only.",
  DEVICE_HELD:
    "The owner is using this device right now. Wait until they hand it back, then try again.",
  DEVICE_BUSY:
    "The device is being reset or deleted, or is stopping. Try again in a moment.",
  DEVICE_NOT_RUNNING: "The device is not running. Start it with device_start.",
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
  DEVICE_TEXT_UNSUPPORTED:
    "Only printable ASCII characters (space to ~) can be typed in this version: no umlauts, accents, emoji, tabs or line breaks. Type the ASCII parts and press keys such as enter with device_key.",
  DEVICE_ELEMENT_STALE:
    "This element number is not from a current overview of this device: none was taken yet, the number is not in it, or the device was restarted or reset since. Call device_ui again and use a number from its result.",
  DEVICE_PATH_OUTSIDE:
    "The path on the host must lie inside your own working folder (a session's project folder or worktree), and must not be a link out of it or a file with several names.",
  DEVICE_PULL_SANDBOXED:
    "A sandboxed session cannot copy files from a device into its working folder: AgentPier runs outside the sandbox and cannot tell whether the sandbox lets this session write there. Read the content with device_shell (cat) and write the file yourself.",
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
};

const megabytes = (bytes) => `${Math.round(bytes / 2 ** 20)} MB`;

/** Whether `code` is a stable code of the device feature. */
export const deviceCode = (code) =>
  typeof code === "string" && /^DEVICES?_[A-Z0-9_]+$/.test(code);

/**
 * The sentence for the refusal `error` (its `code`, and the `detail`, `limit` or
 * `reason` it carries). A code without a sentence of its own names itself.
 */
export function deviceToolMessage(error) {
  const code = error?.code;
  const known = Object.hasOwn(messages, code) ? messages[code] : null;
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
