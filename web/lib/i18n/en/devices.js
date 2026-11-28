export const devicesCopy = {
  title: "Android devices",
  intro:
    "Android phones that run on this computer in Google's Android Emulator, for agents and sessions to test apps and websites on. A running device uses about 3 to 6 GB of memory.",
  loading: "Loading Android devices …",
  featureSub: "Emulated Android phones for agents and sessions.",
  featureStates: {
    installed: "Installed",
    absent: "Not installed",
    working: "Installing",
    failed: "Failed",
    unavailable: "Not available",
  },
  installation: {
    group: "Installation",
    label: "Android Emulator, platform tools and system image",
    description: (download, disk) =>
      `Downloaded from Google into AgentPier's data directory: ${download} to download, ${disk} on disk. Nothing is installed outside it, and your own Android setup stays untouched.`,
    states: {
      absent: "Not installed",
      downloading: "Downloading",
      unpacking: "Unpacking",
      checking: "Checking",
      removing: "Uninstalling",
      installed: "Installed",
      failed: "Failed",
      unavailable: "Not available",
    },
    components: {
      platformTools: "platform tools",
      emulator: "emulator",
      image: "system image",
    },
    downloading: (component, received, total) =>
      `Downloading the ${component}: ${received} of ${total}`,
    unpacking: (component) => `Unpacking the ${component}`,
    checking: (component) => `Checking the ${component}`,
    starting: "Starting the download",
    removing: "Deleting the devices and the Android components",
    updating:
      "A newer version is being installed. Devices cannot start until it is done.",
    versions: (emulator, platformTools, image) =>
      `Emulator ${emulator}, platform tools ${platformTools}, system image ${image}`,
    versionUnknown: "not installed",
    updateFailed: (reason) =>
      `The update to the current versions failed, and the installed versions stay in use. ${reason}`,
    updatePending:
      "This AgentPier version uses newer components. Update them here, or they update at the next start of AgentPier while no device is running.",
    requested:
      "The installation was requested by the installer and starts with the next start of AgentPier. You can also start it here.",
    install: "Install …",
    installHint: (download) => `Downloads ${download} from Google after you confirm.`,
    retry: "Try again …",
    retryHint: "Continues the download where it stopped.",
    update: "Update …",
    updateHint: "Installs the versions this AgentPier version uses.",
    cancel: "Cancel installation",
    cancelHint: "What is downloaded so far stays for the next attempt.",
    remove: "Uninstall …",
    removeHint: "Deletes the Android components and every device.",
    removeBusyHint: "Stop every device first.",
    waitHint: "In progress",
  },
  installDialog: {
    title: "Install Android devices?",
    body: (download, disk, host) =>
      `AgentPier downloads three components from ${host} into its data directory: ${download} to download, ${disk} on disk. A started download continues after an interruption.`,
    componentsLabel: "What is downloaded",
    emulator: (version) => `Android Emulator ${version}`,
    platformTools: (version) => `Android SDK Platform-Tools ${version} (adb)`,
    image: (api, abi) =>
      `Google APIs system image for Android API ${api} (${abi}), without the Play Store`,
    terms:
      "Google provides these components under its own terms. By installing you accept them:",
    notRedistributed:
      "AgentPier passes none of these files on. Each further device needs about 4 GB on disk.",
    confirm: "Accept and install",
  },
  removeDialog: {
    title: "Uninstall Android devices?",
    body: (count) =>
      count === 1
        ? "This deletes the Android components and your 1 device with everything on it: its apps, logins and files. This cannot be undone."
        : `This deletes the Android components and your ${count} devices with everything on them: their apps, logins and files. This cannot be undone.`,
    bodyEmpty:
      "This deletes the Android components from the data directory. There are no devices.",
    confirm: "Uninstall",
  },
  list: {
    group: "Devices",
    add: "+ New device",
    summary: (total, maxDevices, running, maxRunning) =>
      `${total} of ${maxDevices} devices, ${running} of ${maxRunning} running`,
    empty: "No devices yet. Create one with “New device”.",
    emptyNotInstalled: "Install the Android components above to create devices.",
    emptyUnavailable: "This computer cannot run Android devices.",
    states: {
      stopped: "Stopped",
      starting: "Starting",
      running: "Running",
      stopping: "Stopping",
      failed: "Failed",
      resetting: "Resetting",
      deleting: "Deleting",
    },
    creatorOwner: "Created by you",
    creatorAgent: (name) => `Created by agent ${name}`,
    creatorSession: (name) => `Created by session ${name}`,
    creatorGone: "creator no longer exists",
    creatorAgentGone: "Created by an agent that no longer exists",
    creatorSessionGone: "Created by a session that no longer exists",
    assigned: (names) => `Assigned to ${names}`,
    assignedAgent: (name) => `agent ${name}`,
    assignedSession: (name) => `session ${name}`,
    assignedPassed: (name, lead) => `${name} (passed on by ${lead} for a task)`,
    assignedPassedUnnamed: (name) => `${name} (passed on by its lead agent for a task)`,
    assignedMore: (names, more) => `Assigned to ${names} and ${more} more`,
    assignedManage: (name) => `${name} (may reset and delete)`,
    assignedNone: "Not assigned",
    size: (size) => `${size} on disk`,
    held: "You are holding this device",
    viewers: (count) => (count === 1 ? "1 open view" : `${count} open views`),
    imageOutdated:
      "This device uses an earlier system image. It still starts; a reset moves it to the current image.",
    imageOutdatedBlocked:
      "This device uses an earlier system image. It still starts, but it can only be reset once the installation above is up to date.",
    start: "Start",
    stop: "Stop",
    reset: "Reset …",
    delete: "Delete …",
    startNamed: (name) => `Start ${name}`,
    stopNamed: (name) => `Stop ${name}`,
    resetNamed: (name) => `Reset ${name} …`,
    deleteNamed: (name) => `Delete ${name} …`,
    actionsLabel: (name) => `Actions for ${name}`,
    createBlocked: (maxDevices) =>
      `The limit of ${maxDevices} devices is reached. Delete a device or raise the limit below.`,
  },
  createDialog: {
    title: "New device",
    name: "Name",
    nameHint:
      "1 to 40 characters. The device is a phone with Android 16, 720 × 1600 pixels, and needs about 4 GB on disk once it has started.",
    placeholder: "Test phone",
    submit: "Create device",
  },
  resetDialog: {
    title: (name) => `Reset device “${name}”?`,
    body: "The device goes back to its factory state: every app, login and file on it is deleted. Its name stays, and so does who may use it. A running device is stopped first.",
    confirm: "Reset now",
  },
  deleteDialog: {
    title: (name) => `Delete device “${name}”?`,
    body: "The device and everything on it are deleted: its apps, logins and files. A running device is stopped first. This cannot be undone.",
    confirm: "Delete now",
  },
  limits: {
    group: "Limits",
    maxDevices: "Devices in total",
    maxDevicesSub: "1 to 20. Each device takes about 4 GB on disk.",
    maxRunning: "Devices running at once",
    maxRunningSub:
      "1 to 5. Each running device uses about 3 to 6 GB of memory. At the limit, starting another device stops the one that was unused longest.",
    idle: "A running device stops by itself after 15 minutes without use, and all devices stop when AgentPier stops.",
    invalid: "Enter 1 to 20 devices in total and 1 to 5 running at once.",
    save: "Save limits",
  },
  codes: {
    DEVICE_NOT_FOUND: "This device no longer exists.",
    DEVICE_NAME_INVALID: "Enter a name of 1 to 40 characters.",
    DEVICE_NAME_TAKEN: "Another device already has this name. Choose a different one.",
    DEVICE_LIMIT_TOTAL:
      "The limit of devices in total is reached. Delete a device or raise the limit.",
    DEVICE_LIMIT_RUNNING:
      "The limit of devices running at once is reached and every running device is in use. Stop a device or raise the limit.",
    DEVICE_UNAVAILABLE:
      "Android devices are not available right now. Check the installation above.",
    DEVICE_IMAGE_MISSING:
      "The system image this needs is not installed. Update the installation above, then try again.",
    DEVICE_DISK_SPACE:
      "There is too little free disk space for another device. Free up space or delete a device.",
    DEVICE_BUSY: "The device is busy with another operation. Try again in a moment.",
    DEVICE_STOP_FAILED:
      "The device did not stop. Stop it again; if it stays, restart AgentPier, which ends what is left of it.",
    DEVICE_ADB_FAILED:
      "AgentPier could not reach the device through adb. Stop the device and start it again.",
    DEVICE_ADB_PORT_IN_USE:
      "AgentPier's adb port (47600 on this computer) is used by another program, for example a second AgentPier. Close that program, then start the device again.",
    DEVICE_ADB_TIMEOUT:
      "The device did not answer in time. Stop the device and start it again.",
    DEVICE_ADB_CANCELLED: "The call to the device was cancelled.",
    DEVICE_BOOT_TIMEOUT:
      "The device did not finish booting within 3 minutes. Start it again; if it keeps failing, reset it.",
    DEVICE_EXITED:
      "The emulator ended unexpectedly. Start the device again; if it keeps failing, reset it.",
    DEVICE_PORTS_BUSY:
      "AgentPier's ports for devices (47600 to 47621 on this computer) are in use by another program. Close that program, then start the device again.",
    DEVICE_START_FAILED:
      "The device could not be started. Start it again; if it keeps failing, restart AgentPier.",
    DEVICE_START_CANCELLED: "The start was cancelled.",
    DEVICE_FORBIDDEN: "This device may not be used or changed from here.",
    DEVICE_HELD: "You are holding this device, so nothing else can use it right now.",
    DEVICE_NOT_RUNNING: "The device is not running. Start it first.",
    DEVICE_CREATE_FORBIDDEN:
      "This session may not create devices. Allow it under the session's devices.",
    DEVICE_SESSION_INELIGIBLE:
      "Devices can be given to your own running coding sessions only, not to sign-in, pipeline or imported sessions or to sessions of a restricted user's agent.",
    DEVICE_AGENT_INELIGIBLE:
      "Devices can be given to your own agents only, not to an archived agent, an agent of restricted users or an agent with its own Telegram bot for other people.",
    DEVICE_RUN_FORBIDDEN:
      "The agent gets no device in this run, because it works on content that is not your own or its origin is unknown.",
    DEVICE_OWNER_TURN_REQUIRED:
      "An agent creates, resets and deletes devices only in a turn you started with a message of your own.",
    DEVICE_PULL_READONLY:
      "This run may not change files in the agent's workspace, so no file was copied from the device.",
    DEVICE_PASS_INVALID:
      "An agent can pass on to a team member only devices it has itself.",
    DEVICE_ASSIGNMENT_INVALID:
      "This assignment is not valid. A device in it may no longer exist; reload and try again.",
    DEVICE_INPUT_INVALID: "The call to the device had a missing or malformed argument.",
    DEVICE_TEXT_UNSUPPORTED:
      "Only plain ASCII characters can be typed on a device in this version, no umlauts, accents or emoji.",
    DEVICE_ELEMENT_STALE:
      "The element number came from an overview of the screen that is no longer current.",
    DEVICE_PATH_OUTSIDE:
      "The file lies outside the working folder of the session, so it was not read or written.",
    DEVICE_PULL_SANDBOXED:
      "A sandboxed session cannot copy files from a device into its working folder, because its sandbox may allow it to read there only.",
    DEVICE_FILE_NOT_FOUND: "There is no regular file at that path.",
    DEVICE_FILE_TOO_LARGE:
      "The file is too large: up to 200 MB go to a device and up to 50 MB come from it.",
    DEVICE_COMMAND_FAILED: "The device refused the action.",
    DEVICE_SCREEN_UNAVAILABLE:
      "The device did not deliver its screen. Try again in a moment.",
    DEVICE_CALL_TIMEOUT:
      "The call to the device took too long and was ended. A device that was still starting goes on booting.",
    DEVICE_SOURCE:
      "This device was created by a newer AgentPier version and cannot run here.",
    DEVICES_SETTINGS_INVALID:
      "Enter 1 to 20 devices in total and 1 to 5 running at once.",
    DEVICES_TERMS_REQUIRED: "Accept Google's terms to install the components.",
    DEVICES_PLATFORM_UNSUPPORTED:
      "Google's Android Emulator runs on macOS with Apple silicon and on Linux x64 only, so this computer cannot run Android devices.",
    DEVICES_KVM_MISSING:
      "This computer has no /dev/kvm. The emulator needs hardware virtualization: turn it on in the firmware, or turn on nested virtualization if this is a virtual machine.",
    DEVICES_KVM_DENIED:
      "AgentPier may not open /dev/kvm. Add the Linux account AgentPier runs as to the kvm group (sudo usermod -aG kvm <name>), sign that account in again, and restart AgentPier.",
    DEVICES_NOT_INSTALLED: "The Android components are not installed.",
    DEVICES_OPERATION_RUNNING:
      "The Android components are being installed, updated or removed. Wait until that is done.",
    DEVICES_IN_USE: "A device is starting, running or stopping. Stop every device first.",
    DEVICES_SHUTTING_DOWN: "AgentPier is stopping. Try again after it has started.",
    DEVICES_DOWNLOAD_FAILED:
      "The download from Google failed. Check the internet connection and try again; the download continues where it stopped.",
    DEVICES_DOWNLOAD_STALLED:
      "The download from Google stopped making progress. Try again; it continues where it stopped.",
    DEVICES_DOWNLOAD_CANCELLED: "The installation was cancelled.",
    DEVICES_CHECKSUM_MISMATCH:
      "A downloaded file did not match its expected checksum and was discarded. Try again.",
    DEVICES_ARCHIVE_INVALID:
      "A downloaded archive could not be unpacked as expected. Try again.",
    DEVICES_DISK_SPACE:
      "There is too little free disk space for the Android components. Free up space, then try again.",
    DEVICES_SDK_UNUSABLE:
      "The downloaded emulator does not start on this computer. On Linux it needs the libraries libX11 and libX11-xcb (Debian and Ubuntu: sudo apt-get install libx11-6 libx11-xcb1). Then try again.",
    DEVICES_INSTALL_FAILED:
      "The installation or removal failed. Try again; if it keeps failing, check the free disk space and the server log.",
    DEVICES_INTERRUPTED:
      "AgentPier stopped during the installation. Try again; the download continues where it stopped.",
  },
  sdkMissingLibraries: (libraries) =>
    `The downloaded emulator does not start on this computer because these system libraries are missing: ${libraries}. Install the packages that provide them (on Debian and Ubuntu, libx11-6 provides libX11.so.6 and libx11-xcb1 provides libX11-xcb.so.1), then try again.`,
  unknownCode: (code) => `Something went wrong (${code}).`,
  // The Android devices of one coding session: the session's dialog and the
  // new-session dialog's choice.
  access: {
    title: "Android devices",
    summary: "Choose the Android devices this session may use.",
    hint: "The session operates an assigned device with its device tools: it starts and stops it, sees and taps its screen, installs apps and runs commands on it. A device reaches the network and the local services of this computer, so assigning one is an act of trust like assigning a shell.",
    scope:
      "Assignments stay while the session exists, also through a stop and a reload. A device the session created is its own: it may always use, reset and delete it.",
    grantType: "Android device",
    listLabel: "Android devices",
    empty: "No devices yet. Create one under Settings › General › Android devices.",
    busy: "Saving …",
    saved: "Saved.",
    own: "created by this session",
    permissions: "Permissions",
    manage: (name) => `Reset and delete “${name}”`,
    create: "Create devices",
    createSub:
      "Devices the session creates are its own and count towards the limit of devices in total.",
    tools: {
      ready: "Has the device tools",
      missing:
        "This session runs without AgentPier tools. The assignment is saved, but the session gets the device tools only after a reload with AgentPier tools; a session started without them needs a new session.",
    },
    launch: {
      hint: "The session may operate the devices you add with its device tools. Change this later under Android devices in the session.",
      summary: (count) =>
        `${count} ${count === 1 ? "Android device" : "Android devices"}`,
      summaryCreate: "may create devices",
      toolsOff:
        "Without AgentPier tools the session gets no device tools. Turn on AgentPier tools above.",
    },
  },
  // The Android devices of one agent: the group in the agent's Access tab.
  agent: {
    hint: "The agent operates an assigned device with its tool agentpier_device: it starts and stops it, sees and taps its screen, installs apps and runs commands on it. A device reaches the network and the local services of this computer, so assigning one is an act of trust like assigning a shell.",
    allowed: (count) => `Allowed for this agent · ${count}`,
    own: "created by this agent",
    createSub:
      "Devices the agent creates are its own and count towards the limit of devices in total.",
    runs: "The agent uses its devices in every run, also in routines and hooks. It creates, resets and deletes devices only in a turn you started with a message of your own. A run on other people's content, such as a forwarded message, gets no device.",
    member:
      "Its lead agent can also pass a device on to this member for a task. The member uses that device while it works on the task and never resets or deletes it.",
    passed: "Passed on for a task",
    passedSub: "Passed on by the lead agent for a task that is open now. Use only.",
    kept: "What you assigned stays saved and counts again once this no longer applies.",
    manage: "Manage Android devices",
    saveLabel: "Save devices",
  },
  search: {
    newDevice: "New device",
    sessionDevices: "Android devices",
  },
};
