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
- Team members a lead agent delegates to: my call, not the owner's: no device in the
  first version, and devices are not a grant a lead can pass on. A member agent that
  has a device assigned by the owner uses it in its own runs like any agent.
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
- no general `adb shell` tool in the first version (my call: keep the surface small;
  sessions with a shell can be given one later)

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
