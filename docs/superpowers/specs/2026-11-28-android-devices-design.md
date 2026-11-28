# Android devices for agents and CLI sessions

Design for AGENTPIER-508. Working document: delete before the last pull request of this
feature merges (AGENTS.md); lasting guidance moves to `docs/`.

## Intent

Agents and CLI sessions get an Android phone to work with: to test the owner's own apps
and websites on mobile, and to use apps that exist or work only on a phone. The owner can
watch a device and take it over, for example to log in.

Decided by the owner (2026-11-28):

- Android only now. The iOS Simulator is separate work (AGENTPIER-512).
- Standard Android tools: Google's emulator, controlled through `adb`.
- "Device" is an exchangeable source inside AgentPier, so other backends, real phones and
  iOS can follow (AGENTPIER-511, -512) without changing the tools.
- Named devices that the owner creates and assigns to agents and sessions. Agents and
  sessions may also create devices themselves (a fresh device for a test), and reset and
  delete devices.
- The owner's view in the first version: screenshots a few times per second, with
  takeover. A smooth video stream follows right after (AGENTPIER-514).
- The known limits of the first version are follow-up tickets: slow UI overview
  (AGENTPIER-509), ASCII-only typing (AGENTPIER-510), restricted users (AGENTPIER-513),
  pipeline runs (AGENTPIER-516). Devices on other hosts through a bridge client are a
  later idea (AGENTPIER-515).
- An agent may use an assigned device in all its runs, also unattended ones (routines);
  see "Who may do what" for the two exceptions.

## Goals

1. The owner installs "Android devices" from the UI, creates a named device, and sees it
   boot.
2. An agent (OpenClaw and Hermes) and a CLI session (Claude Code, Codex, OpenCode) that
   were given a device can look at it, operate it, install and start apps, open URLs and
   read logs, with the same tools.
3. An agent or session that is allowed to can create, reset and delete devices.
4. The owner watches a device live and takes it over; the agent is blocked meanwhile.
5. Hosts that cannot run it say why, and nothing else changes for them.

## Non-goals (first version)

- iOS, Cuttlefish, redroid, real phones (but the device source layer must allow them).
- Video stream, on-device helper, Unicode typing.
- Restricted users' agents: only the owner's own agents and sessions get devices.
- Pipeline and headless sessions: interactive sessions only (AGENTPIER-516). There is no
  project-level assignment either; devices are assigned per session.
- Play Store images and Google logins provisioned by AgentPier. The pinned image is
  `google_apis` without the Play Store.
- Several Android versions or device shapes to choose from.
- Devices in backups.

## Anti-goals

- A device, the emulator or adb must never use or change the user's own Android setup:
  not `~/.android`, not the default adb server port 5037, not an SDK elsewhere on the
  machine.
- No device keeps running unnoticed and holding gigabytes of memory.
- An agent must not wipe or delete a device the owner set up, unless the owner allowed it.
- No listening port of the emulator or adb reachable from another machine.

## Constraints and measured facts

Spike of 2026-11-28 (details in AGENTPIER-508): emulator 37.3.10, platform-tools 37.0.3,
image `android-36;google_apis`, headless (`-no-window -no-audio -no-boot-anim -gpu
swiftshader_indirect -cores 4`).

|                                | macOS arm64 (M4 Max)             | Linux x64 VM with nested KVM |
| ------------------------------ | -------------------------------- | ---------------------------- |
| Cold boot                      | 24–37 s                          | 29 s (first ever 60 s)       |
| Boot from quick-boot snapshot  | 3–4 s                            | 2.9 s                        |
| Host memory per running device | 5–6 GB                           | 3.4 GB                       |
| Download / on disk             | 5.7 GB SDK                       | 5.3 GB SDK                   |
| Per device on disk             | 1.8 GB, 4.4–4.9 GB with snapshot | 3.4 GB with snapshot         |
| tap / text                     | 18–27 ms / 40 ms                 | 19 ms / 30 ms                |
| screenshot PNG (1080x2400)     | 112–450 ms                       | 876 ms                       |
| `uiautomator dump`             | 2.0 s                            | 2.0 s                        |

- Supported hosts: macOS arm64, Linux x64 with `/dev/kvm` usable by the service user.
  There is no emulator build for Linux arm64. macOS x64 was not measured and is not
  offered.
- The emulator raised a 2048 MB guest to 2560 MB by itself.
- `adb shell input text` fails on non-ASCII text.
- adb wrote `~/.android/adbkey` although `ANDROID_USER_HOME` was set: the processes need
  their own `HOME`.
- The emulator's gRPC endpoint listens on all interfaces without authentication when
  enabled: it stays off.
- Chrome on the image shows first-run screens on its first start.
- A Linux test VM exists for this feature (memory note `project-android-spike-vm`).

How comparable features are built today (verified in the code at 2dfcf5716):

- Agent browser: pinned download with checksums (`server/features/tools/chromium-*.js`),
  unsupported hosts via `chromiumUnavailable`, limits and idle stop in
  `server/features/assistants/agent-browsers.js`, live view over a WebSocket with binary
  frames (`browser-live-view.js`, `server/http/browser-websocket.js`), takeover lease in
  `browser-takeover.js`, UI under `web/features/assistants/browser/`.
- Session tools: families merged in `server/features/mcp/tool-service.js`
  (`previews/preview-mcp.js` is the pattern); per-item grants exist only for SSH
  (`ssh/ssh-integration.js`, `SessionSshDialog.jsx`, `web/components/GrantPicker.jsx`).
- Agent tools from AgentPier: `server/features/assistants/agent-previews.js`
  (`agentpier_preview`) for both runtimes.
- Optional heavy assets and "unavailable" reasons: the embedding assets
  (`runtimes/openclaw/embedding-assets.js`, `semantic-memory.js`).

## Approaches

**Who owns a device** (owner picked 1, with the addition that agents and sessions may
create, reset and delete):

1. Named devices the owner assigns, like SSH accesses. State (apps, logins) persists,
   several agents can use one device after another, memory stays bounded. _Picked._
2. One automatic device per agent and session. No setup, clean separation, but gigabytes
   of disk per agent and quickly a lot of memory.
3. Throwaway devices per task. Always fresh, but logins are lost each time. Covered
   inside 1 by letting agents create and delete devices.

**What emulates the phone** (owner: standard tools first, keep the abstraction):
Google's emulator on both hosts. Cuttlefish and redroid might be lighter or bring a live
view on Linux, but are Linux-only and unmeasured; they become further device sources
later.

**The owner's view** (owner picked 1, then 2):

1. Screenshots a few times per second plus takeover. No extra software. _First version._
2. H.264 video stream through a helper on the device. _Next, AGENTPIER-514._
3. No view. Rejected: the owner could not log in on a device.

## Design

### Device source layer

A device source is the only code that knows how a device comes to exist and run. Its
interface, in terms of what the rest of AgentPier needs:

- availability on this host, with a reason code when unavailable
- create, start, stop, reset (back to the factory state), delete
- state of a device (stopped, starting, running, stopping, failed) and its adb serial

Everything else (tools, view, takeover, limits) talks to a running device through adb
only. The first and only source is the emulator source. A real phone or redroid would be
a source whose devices also end up as adb serials.

### Provisioning

- A pinned manifest (versions, URLs on Google's download servers, SHA-256, sizes) for the
  emulator, platform-tools and one system image per supported host, in the style of the
  Chromium manifest. Downloads are resumable and used only with the pinned digest.
- Installed under `<data>/devices/sdk`, devices under `<data>/devices/avd`, the
  processes' home under `<data>/devices/home`. Emulator and adb always run with that
  `HOME`, SDK and AVD location, and with AgentPier's own adb server port.
- **No Java**: AgentPier downloads the packages itself and writes the AVD files itself
  instead of using `sdkmanager` and `avdmanager`. This is the first thing to prove; if an
  AVD written by hand does not boot reliably on both hosts, stop and report, because the
  alternative (shipping a JRE) changes the size and the licences.
- Install and remove from the UI and from the installer (a flag like the agent browser's),
  never failing the installation. The install dialog names what is downloaded (about
  6 GB), from where, and the licence terms the owner accepts (Android SDK licence, Google
  APIs image terms); nothing is redistributed by AgentPier. `THIRD_PARTY_NOTICES.md` is
  updated. Accepting in the dialog is stored with time and the pinned versions. The
  installer flag counts as acceptance and prints the same terms. Updates of the same
  components in later releases do not ask again. (My call after the review; the owner
  agreed.)
- Linux: the system libraries the emulator needs go into `scripts/install-dependencies.mjs`
  as optional packages. The spike installed `libpulse0 libnss3 libxkbfile1 libxcb-cursor0
libgl1` up front; find the minimal set.
- Unavailable reasons, each with its own text: unsupported platform or architecture, no
  `/dev/kvm`, `/dev/kvm` not usable by the service user (the text names the `kvm` group),
  not installed.
- A later release that pins a new emulator updates it in place. A new system image is
  used for new devices; an existing device keeps the image it was created with until it
  is reset, and an image no device uses is removed.

### Devices

- A device has a name, an id, who created it (owner, an agent, a session), its image and
  its state. One pinned shape: a phone with a moderate screen (my call: 720x1600 at
  320 dpi rather than 1080x2400, for faster screenshots and fewer image tokens; verify
  that apps render sensibly, otherwise 1080x2400), 4 cores, 2 GB guest memory.
- Start boots from the quick-boot snapshot when there is one; stop saves it.
- Reset wipes the device back to the factory state and keeps its name, id and
  assignments.
- Limits, both owner settings: devices in total (my call: default 5) and devices running
  at once (default 2). When the running limit is reached, starting another stops the
  least recently used device that is neither being viewed nor in use, as the agent
  browser does; if there is none, the start fails with a clear message.
- A running device stops after 15 minutes without a tool call or viewer (60 minutes
  while the owner has the view open), like the agent browser.
- All devices stop when AgentPier stops; after an AgentPier restart nothing is left
  running, and a device found running without AgentPier knowing it is stopped.
- Devices are not part of backups; the backup docs say so.
- Chrome's first-run screens are dismissed once when a device is created or reset, if
  that is possible on the pinned image without tricks that only work by accident;
  otherwise the tools' description tells the agent what to expect.

### Who may do what

- The owner assigns devices to an agent (agent settings) and to a session (at launch and
  later, like SSH accesses, using `GrantPicker`).
- Per assignment the owner allows or forbids "reset and delete". Default: forbidden.
- Separately, per agent and per session, the owner allows "create devices". Default: off.
  A device an agent or session created belongs to it: it may use, reset and delete it
  without further permission, and the owner sees it in the device list with its creator
  and can assign it to others or delete it.
- When the creator disappears (session removed, agent deleted), its devices stay and
  show that their creator is gone; the owner decides. (My call: no automatic deletion,
  because a device may hold work.)
- Several agents and sessions may have the same device assigned. Tool calls on one
  device run one after another. There is no lease between agents in the first version.
- Only the owner's own agents and sessions; for a restricted user's agent the capability
  is reported as unavailable.
- Agent runs (decided by the owner): an agent with an assigned device may use it in every
  run, including routines and hooks, with two exceptions. Creating, resetting and
  deleting devices is allowed only in runs the owner started himself (an owner chat
  turn). And runs that process other people's content get no device at all: turns with
  forwarded or foreign content and agents with a bot for other people, by the same
  origin facts `agent-previews.js` uses for its gate. So the device tools need their own
  gate, not the preview gate.
- Team members (decided by the owner): a lead agent may pass a device it has assigned on
  to the members it delegates to, as a grant like the existing member grants
  (`member-grants.js`). A member then uses the device in that task. Because a member's
  run is not started by the owner, it cannot create, reset or delete devices (my call,
  following the rule above). A member agent that has a device assigned by the owner
  uses it in its own runs like any agent.
- A device can reach the network like any program on the host, including the host's own
  loopback through the emulator's host alias. That is wanted (testing a local dev server
  on a phone) and is stated in the docs; assigning a device is an act of trust like
  assigning a shell.

### Tools

The same tool set for sessions (a new family in the session MCP server) and for agents
of both runtimes (following `agentpier_preview`). Names are the builder's, in the style of
the existing families. What they do:

- list the devices available to the caller, with state
- create a device (name), reset, delete, start, stop: subject to the permissions above
- screenshot: returns the image
- UI overview: the visible elements as a compact numbered list (text, description, type,
  bounds, clickable), built from `uiautomator dump`
- tap and long-press, by element number from the last overview or by coordinates
- swipe / scroll
- type text: ASCII only in this version; non-ASCII is refused with a message that says so
  (AGENTPIER-510)
- press a key (back, home, enter, …)
- install an APK; launch and stop an app; list installed apps. The APK must lie inside
  the caller's own area: a session's working folder (its project folder or worktree), an
  agent's workspace. The server resolves the real path and refuses anything outside, so
  a sandboxed session cannot make the server read files beyond its sandbox.
- open a URL
- read recent logs (logcat), bounded
- run a shell command on the device (`adb shell`), with a timeout and bounded output.
  Wanted by the owner: it covers what the fixed tools do not (settings, permissions,
  `dumpsys`, package manager, intents). It runs inside the device, never on the host.
- copy a file to the device and from the device, with the same path rule on the host
  side as the APK install and a size limit

A tool call on a stopped device starts it and waits for the boot. Every tool result is
bounded in size. Tool descriptions say that screen content is untrusted data.

### The owner's view and takeover

- A device list for the owner: name, state, creator, who it is assigned to, size on disk;
  create, start, stop, reset, delete; open the view. Where it lives in the navigation is
  the builder's call within `docs/ui-guide.md`; it needs search index entries.
- The view shows the device screen from repeated screenshots (as fast as the host
  delivers, capped so it does not starve agents; pauses in a hidden tab) over a WebSocket
  in the style of the browser stream. Sent as JPEG if converting is cheap, else PNG.
- Takeover: the owner taps, swipes, types and presses back/home in the view. While the
  owner holds the device, agents' and sessions' tool calls on it are refused with a
  reason, with a lease like the browser takeover's (10 minutes, warning before it ends).
  An agent can ask the owner to take over with a link, like `agentpier:browser-takeover`.
- From an agent chat and from a session, the device in use is one click away (a strip or
  button, as previews and the agent browser have).
- Device state reaches the browser over live topics, not polling.

## Delivery

Four pull requests, each complete with tests, both language catalogs and docs:

1. Provisioning, device source layer, emulator source, device lifecycle and limits, the
   owner's device list (without view).
2. Tools for CLI sessions with assignments and the create permission.
3. Tools for agents of both runtimes with assignments in the agent settings.
4. The owner's view and takeover.

Testing:

- Unit and integration tests run against a fake emulator and fake adb (executables that
  behave like the real ones for the calls AgentPier makes), so they run everywhere.
- One native contract boots the real emulator and exercises every tool once. It runs
  where KVM exists: on the Linux x64 CI runners if they offer `/dev/kvm` (check; nightly
  and on pull requests that touch this feature, assets cached by pin, like the semantic
  memory contract), and by hand on the Proxmox test VM and on the owner's Mac.
- Browser tests for the device list, the grant pickers and the view with a stubbed stream.

Docs to write or update: a new guide for devices, `docs/mcp.md` (session tools),
`docs/assistant-gateway.md` and `docs/hermes-runtime.md` (agent tools),
`docs/installation.md`, `docs/linux.md`, `docs/backups.md`, `docs/architecture.md` (live
topics), both READMEs, `THIRD_PARTY_NOTICES.md`.

## Left to the builder

Tool names and schemas, storage format of devices and assignments, module layout, the
exact UI placement and wording, the frame rate cap, how the numbered overview is
compacted, and the minimal Linux package set.

## State after pull request 1

Pull request 1 (delivery item 1) is built. This section says what exists and what
pull requests 2 to 4 build on; the guide for owners is `docs/devices.md`, and each
module's header comment is the reference for its interface.

### What exists

Backend, `server/features/devices/`:

| Module                                                                         | What it is                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android-manifest.js`, `device-availability.js`                                | The pinned components (emulator 37.3.10, platform-tools 37.0.3, `android-36` `google_apis` r7) with sizes and SHA-256, and why a host cannot run devices                      |
| `android-sdk-install.js`, `android-sdk.js`                                     | Resumable download, unpacking and checks; `AndroidSdk` is the one install, update or remove job with its status, failure codes and the accepted terms                         |
| `device-paths.js`, `device-settings.js`, `device-provisioning.js`              | Everything below `<data>/devices`, the private environment of emulator and adb, the fixed ports (adb server 47600, consoles 47602 to 47620), the limits, the installer option |
| `device-source.js`                                                             | The contract of a device source (twelve methods, `onExit`, the refusal codes)                                                                                                 |
| `emulator-source.js`, `emulator-leftovers.js`, `avd-files.js`, `adb-client.js` | The emulator source: hand-written AVD files, one emulator process per running device, AgentPier's own adb server, reclaim of what an earlier process left                     |
| `device-store.js`                                                              | The records in `devices.json`, with recovery from the device folders when the file is damaged                                                                                 |
| `device-registry.js`, `device-runtime.js`, `device-access.js`                  | Records and in-memory state, the limits, the view, who may use or manage a device, the owner's hold, viewers                                                                  |
| `device-service.js`, `device-admission.js`                                     | `DeviceService` (extends the registry): create, start, stop, reset, delete, adb calls, the running limit with eviction, the idle stop, server start and shutdown              |
| `live-topics.js`                                                               | The topics `devices` and `devices.installation` (owner only)                                                                                                                  |

Wiring: `server/application/device-wiring.js` puts `services.devices` (the
`DeviceService`) and `services.androidSdk` on the application, writes the audit rows
(`device.created`, `device.reset`, `device.deleted`; `tool.installed`,
`tool.cancelled`, `tool.deleted` with resource id `android-devices`), mounts
`server/http/routes/devices.js` and runs start and shutdown. The data area `devices`
is in the storage overview; devices are in no backup.

Routes, owner only (a restricted user gets 404, as for an unknown route):

| Method and path                          | Answer                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| `GET /api/devices`                       | 200, the view (also the value of topic `devices`)        |
| `POST /api/devices` `{ name }`           | 201, a device                                            |
| `POST /api/devices/:id/start`            | 202 once the device holds a running slot, or the refusal |
| `POST /api/devices/:id/stop`             | 202 at once                                              |
| `POST /api/devices/:id/reset`            | 202 when done                                            |
| `DELETE /api/devices/:id`                | 204 when done                                            |
| `PUT /api/devices/settings`              | 200, `{ maxDevices, maxRunning }`                        |
| `GET /api/devices/installation`          | 200, the status (also topic `devices.installation`)      |
| `POST /api/devices/installation/install` | 202, the status; body `{ acceptTerms: true }`            |
| `POST /api/devices/installation/cancel`  | 202, the status                                          |
| `POST /api/devices/installation/remove`  | 202, the status; deletes every device first              |

A refusal is `{ code, error: code }` with status 400, 403, 404 or 409 and, where the
error carries them, `reason`, `image` or `exitCode`. What goes wrong after `start` or
`stop` answered is the device's `failure: { code, at, reason? }`, pushed over the topic.

The view of one device: `id` (`d-` and twelve hex digits), `name`, `source`, `state`
(`stopped`, `starting`, `running`, `stopping`, `failed`), `operation` (`reset`,
`delete` or null), `failure`, `live` (its process still exists), `creator`
(`{ kind, id, name, gone }`), `assignments` (`[{ kind, id, name, manage }]`, empty so
far), `image` (`{ id, current }`), `diskBytes`, `held` and `viewers` (false and 0 so
far), `createdAt`, `lastUsedAt`. Around them: `availability`, `settings`, `counts`.

Codes (each has a text in both catalogs; `tests/unit/device-view.test.js` scans the
server sources for new ones):

- Refusals of a route: `DEVICE_NOT_FOUND` (404), `DEVICE_NAME_INVALID` (400),
  `DEVICE_NAME_TAKEN`, `DEVICE_LIMIT_TOTAL`, `DEVICE_LIMIT_RUNNING`, `DEVICE_BUSY`,
  `DEVICE_UNAVAILABLE` (with `reason`: a host code, `DEVICES_NOT_INSTALLED`,
  `DEVICES_OPERATION_RUNNING`, `DEVICES_SHUTTING_DOWN` or `DEVICE_SOURCE`),
  `DEVICE_IMAGE_MISSING`, `DEVICE_DISK_SPACE`, `DEVICE_STOP_FAILED`,
  `DEVICES_SETTINGS_INVALID` (400), `DEVICES_TERMS_REQUIRED` (400),
  `DEVICES_IN_USE`, `DEVICES_OPERATION_RUNNING`, and the host codes
  `DEVICES_PLATFORM_UNSUPPORTED`, `DEVICES_KVM_MISSING`, `DEVICES_KVM_DENIED`.
- A device's `failure.code`: `DEVICE_BOOT_TIMEOUT`, `DEVICE_EXITED`,
  `DEVICE_PORTS_BUSY`, `DEVICE_IMAGE_MISSING`, `DEVICE_UNAVAILABLE`,
  `DEVICE_ADB_FAILED` (with `reason` `DEVICE_ADB_PORT_IN_USE` when the adb port is
  another program's), `DEVICE_ADB_TIMEOUT`, `DEVICE_BUSY`, `DEVICE_STOP_FAILED`,
  `DEVICE_START_FAILED`.
- The installation's `failure.code`: `DEVICES_DOWNLOAD_FAILED`,
  `DEVICES_DOWNLOAD_STALLED`, `DEVICES_CHECKSUM_MISMATCH`, `DEVICES_ARCHIVE_INVALID`,
  `DEVICES_DISK_SPACE`, `DEVICES_SDK_UNUSABLE` (with `detail.missing`),
  `DEVICES_INSTALL_FAILED`, `DEVICES_INTERRUPTED`.
- Not reachable by the owner's page yet, with texts already: `DEVICE_FORBIDDEN`
  (403), `DEVICE_HELD`, `DEVICE_NOT_RUNNING`, `DEVICE_ADB_CANCELLED`,
  `DEVICE_START_CANCELLED`, `DEVICES_DOWNLOAD_CANCELLED`.

Web: `web/features/devices/` (Settings › General › Android devices at
`/settings/devices`, `useDevices` on both topics, `device-view.js` for every state and
code), search entries in `device-search-entries.js`. Installer:
`--with-android-devices` leaves a request that the next server start installs.

Tests: unit and integration tests on a fake emulator and fake adb
(`tests/helpers/fake-android-sdk.js`, `tests/fixtures/fake-emulator.mjs`,
`fake-adb.mjs`) and on a source in memory (`tests/helpers/memory-device-source.js`,
`device-service-fixture.js`); `tests/browser/devices.spec.js` with the live stub; and
the native contract `tests/integration/android-devices-contract.test.js` with
Google's emulator (`.github/workflows/android-devices.yml`, and by hand with
`AGENTPIER_ANDROID_CONTRACT_SDK`; `scripts/android-device-assets.mjs` installs the
pinned SDK into a data folder for it).

### Seams for pull requests 2 to 4

All on `services.devices`. A caller is `{ kind: "owner" }`, `{ kind: "session", id }`
or `{ kind: "agent", id }`.

| Need                                           | Method                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run an adb command on a device                 | `adb(id, args, { caller, start, timeoutMs, maxBytes, input, signal, encoding, onData })`: queued per device, the caller's grant and the owner's hold checked when the call arrives and again at its turn (also `caller.admit()`, since pull request 3), starts a stopped device unless `start` is false, bounds output and time, counts as use; `encoding: "buffer"` for a screenshot |
| The devices a caller may use                   | `devicesFor(caller)` (each view with `manage`), `permission(caller, id)` (`{ use, manage }`)                                                                                                                                                                                                                                                                                          |
| Grants of sessions, agents and team members    | `registerGrants(kind, resolver)` with `resolver(callerId) -> [{ deviceId, manage }]`; `registerAssignments(kind, lister)` with `lister(deviceId) -> [{ kind, id, name, manage }]` for the view; `onRemoved(listener)` to drop grants                                                                                                                                                  |
| Create, start, stop, reset, delete by a caller | `create({ name, creator })`, `startDevice(id, { caller })`, `stopDevice(id, { caller })`, `reset(id, { caller })`, `remove(id, { caller })`; reset and delete need `manage`, a creator manages its own devices                                                                                                                                                                        |
| The owner takes a device over                  | `hold(id, { ms })` returns `{ release(), extend(ms), until }`; `heldUntil(id)`; other callers get `DEVICE_HELD` meanwhile                                                                                                                                                                                                                                                             |
| A viewer watches a device                      | `watch(id)` returns the function that ends it; a watched device is not stopped for another and stops after 60 instead of 15 idle minutes                                                                                                                                                                                                                                              |
| Follow the state                               | topic `devices`, `onChanged(listener)`, `view()`, `device(id)`                                                                                                                                                                                                                                                                                                                        |
| Whether a creator still exists                 | the `creatorExists(creator)` option of the service (wired to "always" so far)                                                                                                                                                                                                                                                                                                         |
| Another kind of device                         | an object with the methods of `device-source.js` in `sources`; records carry `source`                                                                                                                                                                                                                                                                                                 |
| Steps at a device's first boot                 | `firstBootSteps` in `emulator-source.js` (a later on-device helper is installed there, AGENTPIER-514)                                                                                                                                                                                                                                                                                 |

### What the later pull requests add

2. Session tools (the tool family in `server/features/mcp/tool-service.js`), the grant
   store for sessions with its picker, the per-session permission to create devices,
   and what the session sandbox allows on loopback (adb on loopback is not an access
   boundary, see `docs/devices.md`).
3. The agent tools for both runtimes, assignments in the agent settings and for team
   members, the owner-turn rule and the foreign-content gate before any call.
4. The owner's view over a WebSocket (`watch`, screenshots through `adb` with
   `encoding: "buffer"`), the takeover lease on `hold().extend` with its warning, and
   the strips in agent chats and sessions.

Pull requests 2 and 3 provide `creatorExists` and fill `assignments`; the last pull
request deletes this specification.

### Known and not verified

- On Linux `netsimd` keeps `netsim.ini` in `$XDG_RUNTIME_DIR`; only `TMPDIR` is
  redirected into the data folder. Setting `XDG_RUNTIME_DIR` for the emulator was not
  tried.
- Whether an adb server on the default port 5037 sees AgentPier's devices was checked
  on Linux (it does not) and on macOS only with a second server on another port.
- Two devices at once share one `netsimd` on the fixed port 6402; a collision with an
  emulator the user runs was not provoked.
- Only one AgentPier per machine can run devices (fixed ports); a second one fails
  with `DEVICE_ADB_PORT_IN_USE` and leaves the first one's adb server alone.

## State after pull request 2 (backend)

The backend half of pull request 2 is built: the device actions, the sessions' grants
with their routes and topic, and the session tools. The web part (pickers, dialog,
strip, search entries, texts) builds on what this section lists. Guides:
`docs/devices.md` (Devices for coding sessions), `docs/mcp.md` (Android devices from
sessions).

### Modules

All in `server/features/devices/` unless a path is given.

| Module                                                                         | What it is                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-actions.js`, `device-screen-actions.js`, `device-app-actions.js`       | `DeviceActions#run(action, input, { caller, canCreate, area, areaWritable, scope, protectedRoots, signal })`: the 21 actions, independent of MCP, for sessions and agents                                                                               |
| `device-input.js`, `ui-overview.js`, `host-area.js`                            | Checked and quoted words for the device's shell, the numbered overview from a `uiautomator` dump, and the rule that a host file stays inside the caller's area, which is one folder (`{ path, dev, ino }`, recorded when the caller got it), not a path |
| `session-device-grants.js`                                                     | `SessionDeviceGrants`: `devices/session-grants.json`, the sessions' assignments and create permission, and `deviceEligible`                                                                                                                             |
| `session-device-access.js`                                                     | The value of the routes and of the topic `session.devices`, the check of a launch's `deviceAccess`                                                                                                                                                      |
| `device-mcp.js`, `device-tool-messages.js`                                     | The session tool family and the English sentence for each code                                                                                                                                                                                          |
| `server/http/routes/session-devices.js`, `server/application/device-wiring.js` | The two routes; `services.sessionDeviceGrants` and `services.deviceActions`, registered with `registerGrants("session")`, `registerAssignments("session")`, `onRemoved` and `creatorExists`                                                             |

### Routes (owner only; a restricted user gets 404)

| Method and path                 | Body                                                                                          | Answer                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/sessions/:id/devices` | –                                                                                             | 200, the session's device access                     |
| `PUT /api/sessions/:id/devices` | `{ devices: [{ deviceId, manage }], create }` (both fields, nothing else; at most 20 devices) | 200, the same after the change                       |
| `POST /api/sessions`            | optional `deviceAccess`, the body of the `PUT`                                                | as before; the access is stored with the new session |

The session's device access (also the value of the live topic
`session.devices:<session id>`, registered in `web/lib/live/live-topics.js` with the
path `/sessions/<id>/devices`):

```json
{
  "availability": { "available": true, "reason": null },
  "eligible": true,
  "tools": "ready",
  "create": false,
  "devices": [
    {
      "id": "d-0123456789ab",
      "name": "Pixel",
      "state": "stopped",
      "creator": { "kind": "owner", "id": "owner", "name": "", "gone": false },
      "assigned": true,
      "manage": false,
      "own": false
    }
  ]
}
```

- `devices` is every device, in the order of the device list: the picker's choices.
  `assigned` and `manage` are the owner's grant; `own` says the session created the
  device (then `manage` is true and it needs no grant; `assigned` stays what the owner
  set).
- `eligible` is false for a session that cannot be given devices (not running, a
  shell, sign-in, pipeline or imported session, or started by a restricted user's
  agent). A `PUT` that grants anything to such a session answers 409
  `DEVICE_SESSION_INELIGIBLE`; a `PUT` that grants nothing always works.
- `tools` is `"missing"` when the session has no AgentPier tools: the grant is stored,
  but the session has no device tools until it is reloaded with them (the same
  situation as in `SessionAgentAccessDialog.jsx`).
- `availability` is the device view's: with `available: false` the tools are not
  offered at all.
- Refusals answer `{ code, error: code }`: `DEVICE_ASSIGNMENT_INVALID` (400, another
  shape, a duplicate, or a device that does not exist), `DEVICE_SESSION_INELIGIBLE`
  (409). An unknown session is the session routes' 404. A refused launch answers the
  same codes through the general error handler (`{ error, code }`).
- The device view (`GET /api/devices`, topic `devices`) now fills `assignments` with
  `{ kind: "session", id, name, manage }` (the session's current name) and sets
  `creator.gone` for a device whose creating session was removed. Both topics are
  signalled on every change of a grant and of a device.
- Grants stay through a stop and a reload of their session and go when the session is
  deleted or the device is removed.

### Tools

`devices_list`, `device_create`, `device_start`, `device_stop`, `device_reset`,
`device_delete`, `device_screenshot`, `device_ui`, `device_tap`, `device_swipe`,
`device_key`, `device_type`, `device_install`, `device_push`, `device_pull`,
`device_app_launch`, `device_app_stop`, `device_apps`, `device_open_url`,
`device_logs`, `device_shell`; arguments and results in `docs/mcp.md`. Offered to an
eligible session's context while `devices.availability()` is null, whatever the
session's MCP grant covers.

### Codes added (each with a text in both web catalogs, `devicesCopy.codes`)

`DEVICE_CREATE_FORBIDDEN` (403), `DEVICE_SESSION_INELIGIBLE` (409; 403 from a tool),
`DEVICE_ASSIGNMENT_INVALID` (400), `DEVICE_INPUT_INVALID` (400),
`DEVICE_TEXT_UNSUPPORTED` (400), `DEVICE_ELEMENT_STALE`, `DEVICE_PATH_OUTSIDE` (403),
`DEVICE_PULL_SANDBOXED` (403, a pull in a sandboxed session, decided by `areaWritable`), `DEVICE_FILE_NOT_FOUND`
(404), `DEVICE_FILE_TOO_LARGE` (400), `DEVICE_COMMAND_FAILED`,
`DEVICE_SCREEN_UNAVAILABLE`, `DEVICE_CALL_TIMEOUT` (409 unless noted). Only the first
three reach the owner's pages; the others are answers of a tool. `DEVICE_FORBIDDEN`
and `DEVICE_HELD` are now reachable (by a tool).

### Left for the web part

- The picker in the launch dialog (`deviceAccess` in the launch body) and the dialog of
  a running session (`GET`/`PUT`, `useLiveTopic("session.devices:<id>")`), with
  `GrantPicker`; a per-device switch for "reset and delete" and one switch for "create
  devices". Offer neither while `availability.available` is false or `eligible` is
  false; say so when `tools` is `"missing"`.
- The device list already receives `assignments` and `creator.gone`
  (`device-view.js` renders both).
- Search entries, both language catalogs, browser tests, and the two places in
  `docs/devices.md` that name the controls (marked with an HTML comment).
- No strip for the device in use yet: that belongs to the owner's view (pull request 4).

### Known and not verified (pull request 2)

- Whether a session under nono reaches the adb port was read from nono's documented
  behaviour and the launch code, not tried with a device under nono. That a plain
  local process without any key operates a device through `127.0.0.1:47600`, and that
  the console port refuses commands without its token, was tried.
- The emulator's own adb port (the odd one) was not tried with a foreign adb key.
- Linux: the new actions ran on the real emulator on macOS only; the Linux run is the
  workflow's (`.github/workflows/android-devices.yml`).
- `device_pull` reads the file as one stream (the output of the device's `cat`), cut
  at the limit as it arrives; a file that grows while it is pulled is refused with
  `DEVICE_FILE_TOO_LARGE` and never fills the host's disk. (The watch on a private
  copy that this section first described was replaced in review.)

## State after pull request 2 (web)

The web half of pull request 2 is built. Guide for owners: `docs/devices.md` (Devices
for coding sessions).

### What exists

All in `web/features/devices/` unless a path is given.

| Module                                         | What it is                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-device-access.js`                     | The rules, free of React: the draft `{ devices: [{ deviceId, manage }], create }` (the body of the `PUT` and of `deviceAccess`), `withGranted`, `withManage`, `prunedDraft`, `sameAccess`, the picker entries, `deviceEligibleSession`, `accessBlocked`, `launchSummary`  |
| `DeviceGrantFields.jsx`, `device-grants.css`   | `GrantPicker` over a list of devices with the card **Permissions** as its children: one `ToggleRow` "Reset and delete" per granted device and "Create devices". Takes any `[{ id, name, own? }]` and a draft, so the agent settings of pull request 3 can use it as it is |
| `LaunchDeviceChoices.jsx`                      | The section of the new-session dialog (stacked picker), mounted in `web/features/sessions/LaunchDialog.jsx`                                                                                                                                                               |
| `SessionDevicesDialog.jsx`                     | The dialog of a running session, opened by `web/features/sessions/useSessionActions.jsx` (item `devices`, icon `phone`, page action `session-devices:<id>`)                                                                                                               |
| `useSessionDevices.js`                         | `useSessionDevices(sessionId)` on `session.devices:<id>` with `save(draft)`; `useAssignableDevices()`, the devices of the topic `devices` or null while the host offers none                                                                                              |
| `web/features/quick-open/workspace-entries.js` | `sessionDeviceEntries`: "<session> · Android devices" in ⌘K, while `devicesAvailable`                                                                                                                                                                                     |
| `device-view.js`                               | `assignmentText`: a row of the device list names three assignments and counts the rest                                                                                                                                                                                    |
| Texts                                          | `devicesCopy.access` (dialog, launch, permissions, tools), `devicesCopy.list.assignedMore`, `devicesCopy.search.sessionDevices`                                                                                                                                           |

Rules the web part follows:

- Nothing about devices is shown while `useAssignableDevices()` is null (components
  not installed, host cannot run devices, device view not readable): no section in the
  launch dialog, no action in the session header, no search entry.
- The launch dialog offers the section for coding CLIs without a task profile (the
  server refuses devices for pipeline sessions) and sends `deviceAccess` only when the
  draft grants something. A ticket start passes it on in `session`.
- The session action shows for a running coding session that is no sign-in, pipeline
  or imported session. The one server rule the browser cannot know (a session a
  restricted user's agent started) arrives as `eligible: false`; the dialog then shows
  `DEVICE_SESSION_INELIGIBLE` in words and no choice.
- Reload & resume and a stop do not pass through the web for grants: the server keeps
  them by session id, so the web neither sends nor repeats them. Launch preferences
  (`launch-preferences.js`) remember CLI, access, folder and mode only, as for SSH and
  agents; devices are not remembered.
- A device with `own: true` is a locked picker entry with the note "created by this
  session" and has no switch. Its grant, if the owner gave one, stays in the draft; the
  server reports `manage: true` for it, so a save stores `manage: true` there.
- A push while the dialog is open replaces the choice only while it is unchanged;
  otherwise the draft stays, minus devices that are gone.

Server change in this half: `PUT /api/sessions/:id/devices` is audited as
`session.updated` with `details.kind: "device-grants"` (`audit-http.js`), like a
session's SSH accesses; no device is named.

Changes outside the feature, each with its test:

- `AddPicker` closes its list when an outside press ends, not when it starts. The list
  lies in the page's flow, so the permissions below it moved away under the pointer
  and the first click on a switch was lost.
- `SessionAgentAccessDialog` dropped a grant pushed while nothing was unsaved (it
  compared with the saved grant inside a state updater that ran after the saved grant
  was replaced). `SessionDevicesDialog` reads the saved access before the updater.
- The shared browser fixtures answer `GET /api/devices` with "not installed"
  (`tests/helpers/assistant-browser-fixture.js`, `tests/browser/providers-fixture.js`),
  because session views, the launch dialog and the search now follow that topic.

Tests: `tests/unit/session-device-access.test.js`, `device-view.test.js`
(`assignmentText`), `quick-open.test.js` (the search entry and its page action),
`tests/browser/session-devices.spec.js` (launch, dialog, pushes, tools missing,
ineligible, ⌘K, German, phone), `tests/browser/devices.spec.js` (assignments and a gone
creator, desktop and phone), `tests/integration/session-devices-routes.test.js` (the
audit row).

### Left for pull requests 3 and 4

- Pull request 3: the agent settings use `DeviceGrantFields` with the agents' grants;
  `assignmentText` and `creatorText` already name agents. The device list shows only
  three assignments by name; if agents make longer lists common, a disclosure for the
  rest belongs to the device row.
- Pull request 4: the strip or button that opens a device from a session, and the
  owner's view. The session dialog lists devices by name only; their state
  (`devices[].state`) is delivered and not shown yet.
- Autopilot orders (`web/features/autopilot/OrderSessionFields.jsx`) assign SSH
  accesses and secrets to the sessions they start, not devices: the order service does
  not take `deviceAccess`.

### Known and not verified (pull request 2, web)

- A session that became ineligible while it holds grants (it cannot happen for a
  running session today) gets no control to take them away in the dialog; the server
  accepts an empty `PUT` for it.
- The dialog offers no **Reload** button beside the "without AgentPier tools" note,
  because a reload brings the tools back only when they were revoked, not for a
  session started without them.
- Browser tests ran in Chromium only; WebKit runs with the `webkit` label.

## State after pull request 3 (backend)

The backend half of pull request 3 is built: the agents' grants with their routes and
topic, the agents' tool on both runtimes with its run gate, and what a lead passes on
to a member. The web part (the picker in the agent settings, texts, search entries)
builds on what this section lists. Guides: `docs/devices.md` (Devices for agents),
`docs/assistant-gateway.md` (Android devices), `docs/hermes-runtime.md`.

### Modules

| Module                                                                                                          | What it is                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/features/devices/device-tool-schemas.js`                                                                | The fields and per-action shapes of the device tools, once: the session tools are derived from them, the agents' tool is checked against them                                                                                                                                  |
| `server/features/devices/device-tool-messages.js`                                                               | The sentence per code, worded per audience (`session`, `agent`)                                                                                                                                                                                                                |
| `server/features/devices/agent-device-grants.js`                                                                | `AgentDeviceGrants`: `devices/agent-grants.json`, an agent's assignments, its create permission and its workspace recorded as one folder; disk first                                                                                                                           |
| `server/features/devices/agent-device-access.js`, `server/http/routes/agent-devices.js`                         | The value of the routes and of the topic `agent.devices`, the routes themselves, the audit row                                                                                                                                                                                 |
| `server/features/assistants/agent-device-origin.js`                                                             | The devices' own gate: `deviceAgent` (who can be given devices at all), `deviceOriginKinds` and `deviceOrigin` (the allow-list of recorded origins that may use devices), `taskOrigin`, `taskEnded`, `deviceRun(w, inv)` (the run behind a call, with `manage` and `writable`) |
| `server/features/devices/grant-file.js`                                                                         | Reads `agent-grants.json` and `session-grants.json`: a damaged file or entry is kept aside as `<file>.damaged-<time>`, logged once, and the file written anew from what counts                                                                                                 |
| `server/features/assistants/agent-devices.js`                                                                   | `invokeDevice`: the bridge action `device`; validation, the gate at arrival and at the queue head, the scope of a run, the workspace as area, the screenshot's answer                                                                                                          |
| `server/features/assistants/member-device-passes.js`                                                            | What a lead passes on with a task: the check, the record on the task (`devices`), the live resolution for the device service and the device list                                                                                                                               |
| `server/features/assistants/team-plugin/device-tool.js`, `runtimes/hermes/hermes-config/team-plugin-results.js` | The tool's description and JSON schema and how each runtime's plugin returns a screenshot as an image                                                                                                                                                                          |
| `server/features/assistants/team-bridge-dispatch.js`                                                            | The bridge's dispatch by action, moved out of `team-bridge.js`                                                                                                                                                                                                                 |

Wiring: `device-wiring.js` creates `services.agentDeviceGrants` and registers
`registerGrants("agent")` (direct grants and open task passes),
`registerAssignments("agent")`, `onRemoved` and `creatorExists` for agents; a
device whose creating agent is deleted shows `creator.gone`. `agent-lifecycle.js`
discards a deleted agent's grants. The tool is compiled while
`configuration.devicesAvailable()` holds (`workflow-instruction-wiring.js`), through
`toolGrants({ devices })`.

### Routes (owner only; a restricted user gets 404)

| Method and path                   | Body                                                                                          | Answer                         |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| `GET /api/assistants/:id/devices` | –                                                                                             | 200, the agent's device access |
| `PUT /api/assistants/:id/devices` | `{ devices: [{ deviceId, manage }], create }` (both fields, nothing else; at most 20 devices) | 200, the same after the change |

The agent's device access (also the value of the live topic `agent.devices:<agent
id>`, registered in `web/lib/live/live-topics.js` with the path
`/assistants/<id>/devices`):

```json
{
  "availability": { "available": true, "reason": null },
  "eligible": true,
  "create": false,
  "devices": [
    {
      "id": "d-0123456789ab",
      "name": "Pixel",
      "state": "stopped",
      "creator": { "kind": "owner", "id": "owner", "name": "", "gone": false },
      "assigned": true,
      "manage": false,
      "own": false,
      "passed": false
    }
  ]
}
```

- The same shape as a session's access, without `tools` and with `passed`: the
  agent is a member and its lead passes this device on with a task that is open now.
  `DeviceGrantFields` takes it as it is (`[{ id, name, own }]` and the draft).
- `eligible` is false for an archived agent, an agent of restricted users and an
  agent with its own Telegram bot for other people. A `PUT` that grants anything to
  such an agent answers 409 `DEVICE_AGENT_INELIGIBLE`; a `PUT` that grants nothing
  always works. An agent that became ineligible keeps what the owner set
  (`assigned`), and it counts for nothing meanwhile.
- A member (permanent or temporary) is eligible like any agent of the owner's.
- Refusals answer `{ code, error: code }`: `DEVICE_ASSIGNMENT_INVALID` (400),
  `DEVICE_AGENT_INELIGIBLE` (409). An unknown agent is a 404 as on the other agent
  routes.
- A change is audited as `assistant.updated` with `details.kind: "device-grants"`
  and no device named; a pass as `details.kind: "lead-share"` with `devices` (a
  number) and the task's `requestId`.
- The device view (`GET /api/devices`, topic `devices`) fills `assignments` with
  `{ kind: "agent", id, name, manage }` and, for a pass, `{ kind: "agent", id, name,
manage: false, passedBy: { id, name } }`. A pass that ended with its task leaves
  the list with the next change of the view (the end of a task signals nothing).
- A `PUT` that grants something records the agent's workspace folder anew; that is
  how the owner repairs `DEVICE_PATH_OUTSIDE` after a restore.

### The tool

`agentpier_device`, one tool with `action` (the 21 actions) and the session tools'
fields flat beside it (`device`, `name`, `element`, `x`, `y`, `longPress`, `scroll`,
`x1`, `y1`, `x2`, `y2`, `durationMs`, `key`, `count`, `text`, `path`, `devicePath`,
`package`, `activity`, `all`, `url`, `lines`, `tag`, `priority`, `command`,
`timeoutMs`), the same on OpenClaw and Hermes. An agent's call ends after 110 seconds as a whole (`AGENT_CALL_TIMEOUT_MS`; a session's after 140), and the plugins wait 125; an agent's `shell` takes a `timeoutMs` of at most 100000 (`AGENT_SHELL_TIMEOUT_MAX_MS`), a session's 120000. `agentpier_team_delegate` gained
`access.devices` (1 to 20 ids or names). The run rules are the table in
`docs/assistant-gateway.md` (Android devices).

### Codes added (each with a text in both web catalogs, `devicesCopy.codes`)

`DEVICE_AGENT_INELIGIBLE` (409 from the route, 403 from the tool),
`DEVICE_RUN_FORBIDDEN` (403), `DEVICE_OWNER_TURN_REQUIRED` (403),
`DEVICE_PULL_READONLY` (403), `DEVICE_PASS_INVALID` (409). Only the first reaches the
owner's pages; the others are answers of a tool.

### Left for the web part

- The agent settings: `DeviceGrantFields` on `GET`/`PUT /api/assistants/:id/devices`
  with `useLiveTopic("agent.devices:<id>")`; offered while
  `availability.available`, with `DEVICE_AGENT_INELIGIBLE` in words and no choice
  while `eligible` is false. Where it lives in the settings is the web part's call
  (`docs/agents.md` names it under **Access** for now).
- `passed: true` rows for a member ("passed on by its lead for a task"), and
  `passedBy` in the device list's `assignmentText`.
- Search entries, texts, browser tests; the two READMEs and the controls' names in
  `docs/devices.md` (marked with an HTML comment) and `docs/agents.md`.
- The team settings need nothing: a pass has no owner switch. If the owner should be
  able to forbid passes per lead, that is a new setting on the team policy, read in
  `member-device-passes.js` `checkedPass`.

### Seam for pull request 4 (takeover request)

Nothing built here stands in its way. What it needs:

- A bridge-side entry: either a further action of `agentpier_device` (`ACTIONS` is
  the device actions' list, so a `takeover` action belongs in `agent-devices.js`
  before the dispatch to `DeviceActions`, with its own field in
  `device-tool-schemas.js` and `team-plugin/device-tool.js`), or a card. It should
  pass `deviceRun` like every call and be allowed wherever `use` is.
- The link: the device's view route of pull request 4 with the device id; the
  agent's result should carry it like `agentpier:browser-takeover`, and the
  Telegram notice can follow `notifyAgentPreview` (`agent-previews.js`).
- While the owner holds the device (`DeviceService#hold`), agents' calls answer
  `DEVICE_HELD` already, with a sentence that says to wait; a call that was queued
  is checked again at its turn.
- `agentDeviceAccess` and the device view carry `state` and `held`; the chat strip
  can read which device an agent uses from `lastUsedAt` and the audit, or pull
  request 4 adds a "last caller" to the runtime state.

### Known and not verified (pull request 3, backend)

- The pinned runtimes run the tool in two contracts, both run on macOS (Apple
  silicon) only so far: `tests/integration/assistant-device-tool-contract.test.js`
  (OpenClaw 2026.11.6; the device on a source in memory) and
  `tests/integration/hermes-device-tool-contract.test.js` (the pinned Hermes; the
  devices on the fake SDK). In both the model's request after the tool call carries
  the screenshot as an image part: on OpenClaw in a user message after the tool
  result ("Image(s) from tool result #1 (agentpier_device):", how OpenClaw hands a
  tool result's image to a chat-completions model), on Hermes inside the tool
  message. Their Linux runs are the workflow's (`assistant-runtime.yml`). Neither
  contract boots Google's emulator; the native emulator contract still exercises
  the device actions through a session only.
- The run gate is tested once, on the shared bridge; the Hermes side of it is the
  session key its plugin sends (tested) and the same bridge.
- On Hermes a call's HTTP request is not aborted when its turn is stopped; such a
  call is refused at its turn on the device (`admit`), or runs to its own time limit
  when it had already begun.
- A sender-facing agent on Hermes still lists the tool (Hermes's tool list does not
  apply `senderLockedTools`); every call answers `DEVICE_AGENT_INELIGIBLE`.
- "Forwarded" exists for Telegram messages only; content the owner pastes, or that
  an agent reads in an owner's turn (web, mail, files, a device's screen), is part of
  that turn.

### After the review of pull request 3

An independent review found thirteen points; each has a regression test. What the
sections above say changed as follows:

- **Origins are an allow-list.** `deviceOriginKinds`: `owner` and `telegram` (use and
  manage unless a goal marker is set), `reminder`, `member-result`, `team-result`,
  `coding-result`, `session-talk`, `coding-session`, `member-long-chat`,
  `mail-result`, `ssh-access-result`, `memory-result`, `coding-start` (use only).
  Everything else gets no device, also a kind added later: `memory-step`, the foreign
  kinds, `unknown`, no record. `tests/integration/agent-device-origins.test.js`
  scans the server for the kinds it records as a turn's context and fails for one
  without a decision. A task's origin may also be `routine` (`taskOrigin`).
- **A call is judged by the run it names** (`ownRun`): a `runId` that maps to
  another attempt than the bound one is refused; one that maps to no attempt
  (OpenClaw's completion and check-in runs) uses without `manage`. Hermes sends no
  run id, so there a call counts for the turn its session has.
- **A run without a turn** gets devices only when the chat's latest request has an
  origin of the allow-list (or the chat has no request).
- **A lead's routine on its member** needs what a task needs of the lead (exists,
  no member, `deviceAgent`).
- **A cancelled task** (`cancelRequested`) has ended for the gate and for its pass.
- **A call the runtime gave up** is aborted: the bridge's invocation carries `gone`,
  a signal that aborts when the last connection waiting for the answer closed
  (`TeamBridge#awaited`); only the device action reads it.
- **`create` is asked again at its turn** (`DeviceService#create` `admit`).
- **The workspace record** is only the workspace folder itself (a folder, no link,
  at exactly its name below the real workspaces folder; never the data folder, a
  folder above it or the devices' folder), checked at every use; the owner's `PUT`
  records anew only when the recorded folder is gone or differs and the folder there
  passes the check. Repair after a restore: change the agent's devices and save.
- **Pushes.** `devices` and `agent.devices` read again on every agent-level
  `change` event, which a task's end and stop, archive and restore, a sender bot and
  user access all end with.
- **The add field** of a stacked picker clears the typed text after an add.

Known and not verified after it:

- The run a turn's own device call names is pinned on OpenClaw 2026.11.6
  (`assistant-device-tool-contract.test.js`: it maps to the turn's attempt; there it
  is the attempt's id, which the Gateway also acknowledges the send with), and
  `assistant-owner-run-contract.test.js` pins that a completion run has a run id of
  its own. No contract exercises a device call of a completion run while a turn is
  bound; that case is covered on the shared bridge only.
- A `member-result` turn also carries a member's report from a hook's or a routine's
  run; it uses devices like any member result, as decided.
- The web app sends the devices only when their draft changed, so the repair of a
  restored workspace needs a changed draft (or the API); there is no button for it.
- `reminder` is in the allow-list but no turn is recorded with that kind today: a
  reminder runs as a Gateway job without tools.

## State after pull request 3 (web)

The web half of pull request 3 is built. Guides for owners: `docs/devices.md` (Devices
for agents; Devices) and `docs/agents.md` (Access).

### What exists

| Module                                                            | What it is                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/features/devices/agent-device-access.js`                     | The rules, free of React: the draft in one order (`orderedDraft`, `agentAccessDraft`), the body of the `PUT` without devices that are gone (`agentAccessBody`), `agentAccessBlocked`, `keptAssignment`, `passedDevices`, the heading and `devicesStep` |
| `web/features/devices/useAgentDevices.js`                         | `useAgentDevices(agentId)` on `agent.devices:<id>`: `{ offered, access, error, refresh, save }`. Nothing is read while `useAssignableDevices()` is null                                                                                                |
| `web/features/assistants/settings/access/DevicesAccess.jsx`       | The group `#agent-access-devices` of the Access tab: `DeviceGrantFields` stacked, the list **Passed on for a task**, the run rules, the link to Settings › General › Android devices; the reason in words for an agent that gets no devices            |
| `web/features/assistants/settings/access/MemberDevicesAccess.jsx` | The same group for a temporary member, with a draft and save bar of its own (**Save devices**), mounted in `MemberAccess.jsx`                                                                                                                          |
| `web/features/devices/DeviceGrantFields.jsx`                      | Takes `ownNote` and `createSub`, the agent's wording of "created by this session" and of the note under **Create devices**                                                                                                                             |
| `web/features/devices/device-view.js`                             | `assignmentText` names the kind ("agent Home", "session Checkout") and a pass ("agent Scout (passed on by Home for a task)"); a creator that is gone and left no name reads "Created by an agent that no longer exists"                                |
| `web/app/agent-search-entries.js`                                 | `agent:<id>:group:devices`, "<agent> · Android devices", for every agent of the owner's while `devicesAvailable` (`buildSearchIndex`, passed by `SearchDialog.jsx`)                                                                                    |
| Texts                                                             | `devicesCopy.agent`, `devicesCopy.list.assignedAgent`, `assignedSession`, `assignedPassed`, `assignedPassedUnnamed`, `creatorAgentGone`, `creatorSessionGone`                                                                                          |

Rules the web part follows:

- The group is the last one of the Access tab, after Email, and shows only while the
  host offers devices. For an agent of the owner's and a permanent member the choice
  is the field `devices` of the tab's draft (`AccessTab.jsx`): it saves with **Save
  agent** through its own step (`PUT /api/assistants/:id/devices`, after the access
  and MCP steps) and is listed in the tab's conflict notice as **Android devices**.
- A push while the choice is unedited replaces it. A push that changes the grants
  while it is edited keeps the edit and is the tab's conflict ("Changed elsewhere in
  the meantime." with **Reload** and **Overwrite anyway**); a device that only
  changed its state is no conflict, because the draft holds grants only, in one
  order. A device deleted meanwhile leaves the picker and is not sent.
- The `PUT` has no revision. A refusal shows in the save bar in words
  (`refusalText`); a 409 `DEVICE_AGENT_INELIGIBLE` is an error, not a conflict.
- `eligible: false` shows `DEVICE_AGENT_INELIGIBLE` in words with a shield, no
  picker and no switch, and adds that the assignment is kept when there is one. An
  agent of users shows it beside its lock notice.
- `own: true` is a locked entry "created by this agent" without a switch;
  `passed: true` is a row of **Passed on for a task**, read only. A passed device
  stays an ordinary candidate of the picker, so the owner can assign it as well.
- The run rules are a visible paragraph below the group, not a hint; for a member
  (`teamMemberId`) a sentence about its lead's passes follows. The hint behind ⓘ
  says what the tool does and that a device reaches the network.
- A temporary member's Access tab is its lead's and has no draft, so its devices
  carry their own (`useTabDraft` with the one field, the tab's unsaved-changes
  guard, **Save devices**).

Tests: `tests/unit/agent-device-access.test.js`, `device-view.test.js` (agents, a
pass, the cap, a creator without a name), `search-index-agent-groups.test.js` and
`quick-open.test.js` (the entry), `tests/browser/agent-devices.spec.js` (assign and
save, pushes while editing, a refused save, the ineligible agent, a permanent and a
temporary member with an own and a passed device, a host without devices, ⌘K,
German, phone in both languages), `tests/browser/devices.spec.js` (agents, a pass
and a gone agent creator on the device page; desktop, German, phone).

### Left for pull request 4

- The owner's view and takeover, and any strip or button that opens a device from
  a chat. The group lists devices by name; `devices[].state` is delivered and not
  shown.
- The device list still names three assignments and counts the rest; a disclosure
  for the rest belongs to the device row if long lists become common.

### Known and not verified (pull request 3, web)

- An ineligible agent that holds assignments gets no control to take them away; the
  server accepts an empty `PUT` for it and the note says that the assignment is kept.
- The Access tab's save bar keeps its note "Applies before the next message." also
  when only devices changed, which apply at once.
- The search entry opens the Access tab; it does not scroll to the group, like the
  other group entries.
- Browser tests ran in Chromium only; WebKit runs with the `webkit` label.
