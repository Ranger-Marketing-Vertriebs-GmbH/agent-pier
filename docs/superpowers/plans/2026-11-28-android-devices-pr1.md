# Android devices, PR 1 of 4: provisioning, device sources, lifecycle and the owner's device list

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or superpowers:executing-plans) to implement this plan task by task. Each task is written for an engineer who sees only that task plus the spec.

**Goal:** The owner installs "Android devices" from the UI or the installer, creates named devices, and starts, stops, resets and deletes them within limits, on macOS arm64 and Linux x64 with KVM, without Java and without touching the user's own Android setup.

**Architecture:** A new backend feature `server/features/devices/` with three layers. `AndroidSdk` downloads pinned archives and reports install state. `EmulatorSource` is the only code that knows how a device exists and runs (it writes AVD files, spawns the emulator, owns a private adb server). `DeviceService` holds records, limits, idle stop, a per-device serial queue, owner holds and the access seam, and talks to a running device through adb only. State reaches the browser over two live topics; the UI is a settings subpage.

**Tech stack:** Node.js ES modules, Express routers, `node:test`, React with the `docs/ui-guide.md` components, yazl/yauzl (already dependencies), Playwright with the live stub.

**Spec:** `docs/superpowers/specs/2026-11-28-android-devices-design.md` (delivery item 1 only).

## Global Constraints

- Supported hosts: `darwin-arm64`, and `linux-x64` with `/dev/kvm` readable and writable by the service user. Everything else is unavailable with a reason code.
- Pinned: emulator 37.3.10 (build 16970787), platform-tools 37.0.3, system image `android-36` `google_apis` revision 7 (`arm64-v8a` on macOS, `x86_64` on Linux). No Play Store image.
- No Java: no `sdkmanager`, no `avdmanager`. AgentPier downloads the zips and writes the AVD files itself.
- Downloads: HTTPS only, resumable, used only when size and SHA-256 match the manifest. Nothing is redistributed.
- Data layout: `<data>/devices/sdk`, `<data>/devices/avd`, `<data>/devices/home`, plus `devices.json`, `settings.json`, `run/`, `logs/`, all 0700/0600.
- Every emulator and adb process runs with `HOME=<data>/devices/home`, `ANDROID_SDK_ROOT` and `ANDROID_HOME` set to the SDK, `ANDROID_AVD_HOME` to the AVD folder, `ANDROID_USER_HOME` and `ANDROID_EMULATOR_HOME` to `<home>/.android`, and `ANDROID_ADB_SERVER_PORT` set to AgentPier's port. Never `~/.android`, never port 5037, never an SDK elsewhere.
- Emulator flags: `-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -cores 4 -memory 2048 -no-metrics`. Never `-grpc`. All listeners on loopback.
- Ports (to be confirmed by Task 1): adb server 47600; console ports 47602 to 47620 (even), device adb port = console + 1; the serial is `emulator-<console>`. These lie outside adb's own emulator scan range 5555 to 5585.
- Device shape: 720x1600 at 320 dpi, 4 cores, 2048 MB guest memory (the emulator raises it to 2560). Fall back to 1080x2400 at 420 dpi only if Task 1 shows broken rendering.
- Device states: `stopped`, `starting`, `running`, `stopping`, `failed`.
- Settings and defaults: `maxDevices` 5 (allowed 1 to 20), `maxRunning` 2 (allowed 1 to 5).
- Timing: idle stop after 15 min, 60 min while viewed, "in use" for 5 min after the last call, sweep every 60 s (the values of `agent-browsers.js`). Boot timeout 180 s. Stop grace 30 s, then SIGTERM, then SIGKILL after 5 s.
- Boot is complete when `adb -s <serial> shell getprop sys.boot_completed` prints `1`. Stop is `adb -s <serial> emu kill`, which saves the quick-boot snapshot.
- Shutdown budget: `server/index.js` forces the exit after 6 s, so device shutdown waits at most 3 s. The next start reclaims what is left.
- Files checked by `check:structure` stay at or under 600 lines. `server/application/services.js` is at 600 and `server/app.js` at 594, so wiring goes into a new file and `app.js` gains two lines.
- UI: only `docs/ui-guide.md` components and tokens; German and English catalogs with matching keys; `npm run i18n:confirm -- devices` and commit `web/lib/i18n/translation-lock.json`.
- Search: new page and actions get entries in `web/app/search-entries.js`, with tests in `tests/unit/search-index.test.js` and `tests/unit/quick-open.test.js`.
- Live: state reaches the browser through topics `devices` and `devices.installation`. No timed polling beyond the channel's own fallback.
- Refusals carry a stable `code` only (`{ code, error: code }`), translated in the web app, as `server/http/routes/assistant-semantic-memory.js` does. No new server catalog keys are needed.
- Docs, commits and PR text in English; docs change in the same PR. Before opening PR 1, delete this plan file. The spec stays until PR 4 (unfinished work tracked in AGENTPIER-508).
- Tests never start a real emulator, except the one native contract, which skips cleanly.

## Review Focus

Each failure mode has a test in the task that owns the code.

| Failure mode                                                        | Why it bites                                                            | Test lives in                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Download interrupted, stalled or disk full during a 6 GB install    | Hours lost, or a half-installed SDK that looks installed                | Task 4                                        |
| Emulator process dies or hangs during boot                          | A device stuck in `starting` forever holds a running slot               | Task 5                                        |
| AgentPier restarts or crashes while devices run                     | Orphan processes hold 3 to 6 GB each, unnoticed                         | Task 5 (reclaim), Task 6 (start and shutdown) |
| Two starts race at the running limit                                | Three emulators run with a limit of two, or the wrong device is evicted | Task 6                                        |
| The user's own Android setup, or another adb server, on the machine | AgentPier kills or reconfigures something that is not its own           | Task 5, and the native contract               |

Also tested, though simpler: `/dev/kvm` missing or not permitted (Task 2, shown in Task 9).

## Decisions where the codebase offers two patterns

- **Install job: own service, not `ToolInstaller`.** Follow `runtimes/openclaw/semantic-memory.js` (own state, own topic, failure codes) rather than the Chromium job in `tools/tool-installer.js`. That installer runs one job at a time for all tools, is at 555 lines, and its download is not resumable.
- **Installer flag: leave a request, do not download.** Follow `tools/craft-provisioning.js` rather than `tools/chromium-provisioning.js`. A 6 GB download inside the installer would block the first service start without progress; the server downloads resumably and shows it.
- **Resumable download: one implementation.** Move `downloadPinned` out of `embedding-assets.js` into a shared module with a code prefix, instead of copying 100 lines; the existing test keeps guarding it.
- **SDK directories: staged folder plus rename, no activation link.** Follow `ensureEmbeddingServer` rather than Chromium's symlink, because the emulator locates its files relative to its own path and a link is one more thing to prove.
- **Persistence: feature-owned JSON files under `<data>/devices/`.** Follow `semantic-memory.json` and Craft's `settings.json` rather than `config.json` (`preview-config.js`). The installer step must write them without loading the server, `config.json` travels in backups, and removal deletes one folder.
- **UI placement: Settings, section `devices` at `/settings/devices`.** Devices serve sessions and agents alike, as previews do (Settings › Remote); Agents › Runtime and CLIs & extensions each cover only one side.

## State storage

- `<data>/devices/settings.json`: `{ maxDevices, maxRunning, requested, terms: { acceptedAt, by: "owner" | "installer", versions: { emulator, platformTools, image } } | null, failure: { code, at, detail? } | null }`. Written with `writePrivate` (`server/lib/storage.js`).
- `<data>/devices/devices.json`: `{ version: 1, devices: [record] }`. A record is `{ id, name, source: "emulator", creator: { kind: "owner" | "agent" | "session", id, name }, image, provisioned, createdAt, lastUsedAt, resetAt }`. No runtime state.
- `<data>/devices/run/<id>.json`: `{ pid, startTime, consolePort, adbPort }` while a device process exists; `adb-server.json`: `{ pid, startTime, port }`. Used only to reclaim orphans.
- `<data>/devices/logs/<id>.log`: the emulator output of the last start. Never sent to the browser.
- Component receipts: `agentpier-receipt.json` inside each installed SDK directory (`{ version, sha256 }`).
- State, serial, viewers, holds and queues live in memory.

---

## Task 1: Prove a hand-written AVD boots from directly downloaded zips (throwaway)

No production code. Work in a scratch folder outside the repo, on the owner's Mac and on the Linux test VM (memory note `project-android-spike-vm`). **If any "must" below fails on either host, stop and report; do not continue with Task 2.** The alternative is shipping a JRE, which changes size and licences and is the owner's decision.

**Files:** none in the repo. Write the findings into the "Task 1 findings" section at the end of this plan and commit only that edit.

**Compare against:** the avdmanager-created AVD of the spike at `/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/d673da4e-e4d0-40a4-a8b9-f41e258c6512/scratchpad/android-spike/avd/` (`spike.ini`, `spike.avd/config.ini`, `spike.avd/hardware-qemu.ini`).

- `spike.ini` has three keys: `avd.ini.encoding`, `path`, `target`.
- `config.ini` has about 130 keys; most are defaults.
- `hardware-qemu.ini` is what the emulator resolved.
- The scratchpad can be cleared by a reboot. If it is gone, create a reference AVD once with avdmanager on the test VM.

**Steps:**

- [ ] Download with `curl` from `https://dl.google.com/android/repository/`: `emulator-darwin_aarch64-16970787.zip` (420629851 bytes, SHA-1 `3ec739595d44092e835f006d806dd380bc8d6dd7`), `emulator-linux_x64-16970787.zip` (350068887, `5f7314368fc6c05c937f6991bb4106214dc389e7`), `platform-tools_r37.0.3-darwin.zip` (16597626, `d48920e2650321710b4d15d3acd9e277d59cd55b`), `platform-tools_r37.0.3-linux.zip` (9571024, `e1579b288a7ae4e9bc28dedec6a154d78b3c04ed`). Take the image zips for `android-36` `google_apis` revision 7 from `sys-img/google_apis/sys-img2-3.xml`. Record every redirect host `curl -v` shows.
- [ ] Unzip with plain `unzip` into `sdk/emulator`, `sdk/platform-tools` and `sdk/system-images/android-36-google_apis-r7/<abi>/` (a non-standard image path on purpose). Record each zip's top-level folder, file count and expanded size.
- [ ] Write `avd/<id>.ini` and `avd/<id>.avd/config.ini` by hand. Candidate minimal `config.ini`: `avd.ini.encoding`, `abi.type`, `hw.cpu.arch`, `hw.cpu.ncore=4`, `hw.ramSize=2048`, `hw.lcd.width=720`, `hw.lcd.height=1600`, `hw.lcd.density=320`, `hw.gpu.enabled=yes`, `hw.gpu.mode=swiftshader_indirect`, `hw.keyboard=no`, `hw.sdCard=no`, `image.sysdir.1=system-images/android-36-google_apis-r7/<abi>/`, `tag.id=google_apis`, `tag.display=Google APIs`, `target=android-36`, `PlayStore.enabled=no`, `disk.dataPartition.size=6G`, `fastboot.forceFastBoot=yes`, `vm.heapSize=228M`.
- [ ] Boot with the environment and flags of Global Constraints and `-ports 47602,47603`. **Must:** `sys.boot_completed` is 1 within 180 s on both hosts, three cold boots in a row.
- [ ] **Must:** `adb emu kill` saves a snapshot and the next start boots from it (seconds, not a cold boot).
- [ ] **Must:** diff the new `hardware-qemu.ini` against the spike's. Only paths, the name, the screen values and keys you removed on purpose may differ. List the differences.
- [ ] **Must:** the real `~/.android` is untouched (compare a listing before and after). Nothing listens on 5037 because of us. Every listening socket of the emulator and adb processes is on 127.0.0.1 or ::1 (`lsof -iTCP -sTCP:LISTEN -P` on macOS, `ss -ltnp` on Linux). No gRPC port is open without `-grpc`. Note: the spike's `emu-launch-params.txt` shows one run with `-grpc 8564`, so check a run without it.
- [ ] Decide the adb server mode. Preferred: AgentPier's own child, `adb -L tcp:localhost:47600 server nodaemon`, so there is a pid to own. Record whether platform-tools 37.0.3 accepts it and whether the emulator registers with it. Fallback: `start-server` and `kill-server` on the private port.
- [ ] Decide the ports. Check that `-ports 47602,47603` is accepted, that our adb server lists `emulator-47602`, and that an adb server on 5037 started afterwards does not list it. Fallback if refused: `-port` values 5586 to 5682, which are legal and above adb's scan range.
- [ ] Robustness: `kill -9` the emulator while it runs, then start again. It must boot (cold is fine). Record what the emulator writes outside the data folder (the spike log shows crash data under `/tmp/android-<user>/`).
- [ ] Screen: open Settings and Chrome at 720x1600/320 and judge the rendering from a screenshot. Record the decision.
- [ ] Chrome first run: find out whether the first-run screens can be dismissed by a documented means on this image (not a trick that works by accident). Record "yes, with these adb commands" or "no".
- [ ] Linux packages: on a minimal Ubuntu and Debian, run `ldd` over `sdk/emulator/emulator` and the `qemu-system-*` binary and boot once. Record the smallest package set that removes every "not found" and boots. Start from `libpulse0 libnss3 libxkbfile1 libxcb-cursor0 libgl1`.
- [ ] Check on a GitHub-hosted `ubuntu-latest` runner whether `/dev/kvm` exists and what makes it usable; a throwaway workflow run on a branch is enough.
- [ ] Commit the findings: `chore: record Android AVD proof findings`.

## Task 2: Pinned manifest, host support and availability

**Files:**

- Create: `server/features/devices/android-manifest.js`, `server/features/devices/device-availability.js`, `scripts/refresh-android-manifest.mjs`
- Modify: `THIRD_PARTY_NOTICES.md` (new section "Android emulator, platform tools and system image": downloaded on the owner's request from Google, not redistributed, licences named)
- Test: `tests/unit/android-manifest.test.js`, `tests/unit/device-availability.test.js`

**Interfaces**

Consumes: Task 1 findings (archive names, redirect hosts, port and shape decisions).

Produces:

```js
// android-manifest.js (style of server/features/tools/chromium-manifest.js)
export const androidManifest = {
  baseUrl: "https://dl.google.com/android/repository/",
  hosts: ["dl.google.com" /* plus redirect hosts found in Task 1 */],
  emulator: { version: "37.3.10", build: "16970787", archives: { "darwin-arm64": A, "linux-x64": A } },
  platformTools: { version: "37.0.3", archives: { "darwin-arm64": A, "linux-x64": A } },
  image: { id: "android-36-google_apis-r7", api: 36, tag: "google_apis", revision: 7,
           archives: { "darwin-arm64": { ...A, abi: "arm64-v8a" }, "linux-x64": { ...A, abi: "x86_64" } } },
  shape: { width: 720, height: 1600, density: 320, cores: 4, memoryMb: 2048, dataPartition: "6G" },
  licences: [{ id, name, url }],   // the licence ids the pinned packages reference in the index
};
// A = { url, sha256, size, top, expandedBytes, files }
export function androidPlatform(platform = process.platform, arch = process.arch); // "darwin-arm64" | "linux-x64" | null
export function downloadBytes(manifest, key);  // sum of the three archive sizes
export function diskBytes(manifest, key);      // sum of expandedBytes

// device-availability.js
export const AVAILABILITY_CODES; // DEVICES_PLATFORM_UNSUPPORTED, DEVICES_KVM_MISSING, DEVICES_KVM_DENIED
export function hostProblem({ platform, arch, manifest, access = fs.accessSync, exists = fs.existsSync } = {});
// null, or one of the three codes. Linux: /dev/kvm absent -> KVM_MISSING; present but not R_OK|W_OK -> KVM_DENIED.
```

`scripts/refresh-android-manifest.mjs` works in the style of `scripts/refresh-rea-lock.mjs`:

- Reads `repository2-3.xml` and `sys-img/google_apis/sys-img2-3.xml`.
- Finds the named revisions and downloads each archive into a temporary folder.
- Checks size and SHA-1 against the index, computes the SHA-256, counts files and expanded bytes.
- Prints the manifest entries. It refuses to print an entry whose SHA-1 does not match the index.

**Steps:**

- [ ] Write the failing tests.
  - `android-manifest.test.js`: every archive has an `https://dl.google.com/` URL, a 64-hex `sha256`, a positive integer `size`, `top`, `expandedBytes`; both platforms exist for all three components; `androidPlatform("darwin","x64")` and `("linux","arm64")` are null.
  - The script's pure part (`parseIndex(xml)`, `pick(index, { path, revision, os, arch })`) finds the pinned archive in a small XML fixture and throws for a missing revision.
  - `device-availability.test.js`: the three codes, plus null for `darwin-arm64` and for `linux-x64` with an accessible `/dev/kvm`, each through injected `access` and `exists`.
- [ ] Run: `node --test tests/unit/android-manifest.test.js tests/unit/device-availability.test.js`. Expect failure (modules missing).
- [ ] Implement. Run the script for real once and paste its output into the manifest; the header comment states the date and that Google's index only gives SHA-1.
- [ ] Run the tests again, then `npm run lint && npm run format:check && npm run check:structure`.
- [ ] Commit: `feat: pin the Android emulator, platform tools and system image`.

## Task 3: Fake `emulator` and `adb` executables

**Files:**

- Create: `tests/fixtures/fake-emulator.mjs`, `tests/fixtures/fake-adb.mjs`, `tests/helpers/fake-android-sdk.js`
- Test: `tests/unit/fake-android-sdk.test.js`

**Interfaces**

Produces:

```js
// tests/helpers/fake-android-sdk.js
export async function fakeAndroidSdk({ root, platform = "linux-x64" } = {});
// -> { dataDir, paths, manifest, fetchImpl, state, behaviour(patch), calls(), launches(), cleanup() }
//   manifest : androidManifest shape, pinned to the fake archives (real sha256 and size)
//   fetchImpl: serves those archives, honours Range, can be told to fail:
//              fetchImpl.failAfter(bytes), .stall(), .corrupt(), .status(code)
//   behaviour: writes <state>/behaviour.json read by both fakes
//   calls()  : parsed <state>/adb-calls.jsonl -> [{ argv, env: { HOME, ANDROID_* } }]
//   launches(): [{ avd, argv, env, pid }] of the fake emulator
export async function installFakeSdk(dataDir, manifest); // unpacked SDK with receipts, without downloading
```

The archives are built with yazl as in `tests/integration/managed-chromium.test.js`: `emulator/emulator` and `platform-tools/adb` are Node scripts with a shebang and mode 0755, and the image zip holds small placeholder files under `<abi>/`.

What the fakes must imitate:

- **`fake-emulator.mjs`**
  - `-version` prints `Android emulator version 37.3.10.0 (build_id 16970787)`.
  - `-avd <id> -ports <console>,<adb>`: exits 1 with `Unknown AVD name` unless `$ANDROID_AVD_HOME/<id>.ini` and `<id>.avd/config.ini` exist and carry `image.sysdir.1`, `abi.type`, `hw.lcd.width`.
  - Binds the console port on 127.0.0.1, so a busy port is real.
  - Writes `<state>/emulator-<console>.json` with `{ pid, bootAt }` and a launch record with argv and environment.
  - Modes from `behaviour.json`: `boot` (default; "booted" after `bootMs`, 50 ms), `hang` (never boots), `die` (exits 1 after `dieMs`, before boot), `crash` (exits after boot), `stubborn` (ignores the kill request and SIGTERM).
  - On the kill request it writes `<id>.avd/snapshots/default_boot/snapshot.pb` and exits 0.
- **`fake-adb.mjs`**
  - `version` prints `Android Debug Bridge version 1.0.41\nVersion 37.0.3-...`.
  - Server mode: binds the port from `-L` or `ANDROID_ADB_SERVER_PORT` on 127.0.0.1, in the form Task 1 chose. It exits 1 with `cannot bind` when the port is taken.
  - `devices` lists running fake emulators.
  - `-s emulator-N shell getprop sys.boot_completed` prints `1` once booted, else an empty line.
  - `-s emulator-N emu kill` signals the fake emulator.
  - `-s emulator-N shell <cmd>` echoes `<cmd>` and honours `behaviour.shell = { stdout, code, delayMs }`.
  - An unknown serial prints `adb: device 'X' not found` and exits 1.
  - Every call is appended to `adb-calls.jsonl` with its environment.

**Steps:**

- [ ] Write the failing test. Through `child_process.execFile`: the emulator refuses an unknown AVD; boots and is reported booted by adb; `emu kill` writes the snapshot marker and ends the process; each mode behaves as described; a second fake adb server on the same port fails; calls and launches record `HOME`.
- [ ] Run: `node --test tests/unit/fake-android-sdk.test.js`. Expect failure.
- [ ] Implement the two scripts and the helper.
- [ ] Run again. Expect pass, with no process left behind (the test asserts every recorded pid is gone).
- [ ] Commit: `test: add fake Android emulator and adb executables`.

## Task 4: SDK installation: download, install, update, remove, states

**Files:**

- Create: `server/features/tools/pinned-download.js`, `server/features/devices/device-paths.js`, `server/features/devices/android-sdk-install.js`, `server/features/devices/android-sdk.js`, `server/features/devices/device-settings.js`
- Modify: `server/features/assistants/runtimes/openclaw/embedding-assets.js` (import the moved functions and re-export `downloadPinned`, so its callers and `tests/unit/embedding-assets.test.js` stay unchanged)
- Test: `tests/unit/pinned-download.test.js`, `tests/unit/android-sdk-install.test.js`, `tests/unit/android-sdk.test.js`, `tests/unit/device-settings.test.js`

**Interfaces**

Consumes: `androidManifest`, `androidPlatform`, `hostProblem` (Task 2); `fakeAndroidSdk` (Task 3); `unpackZip(file, dest, top, signal, limits)` from `server/features/tools/zip-unpack.js`; `run(command, args, env, cwd, signal, timeout)` from `server/features/tools/tool-run.js`.

Produces:

```js
// tools/pinned-download.js: moved from embedding-assets.js, behaviour unchanged
export async function downloadPinned({ url, file, size, sha256, fetchImpl, onProgress, signal, timeoutMs,
                                       prefix = "EMBEDDING", hosts = null });
// codes: <prefix>_DOWNLOAD_FAILED | _DOWNLOAD_STALLED | _DOWNLOAD_CANCELLED | _CHECKSUM_MISMATCH
// hosts: when given, every hop (also a redirect) must be https and on that list
export async function downloadResumed(options, attempts = 3);
export async function requireSpace(directory, bytes, code);

// devices/device-paths.js
export function devicePaths(dataDir, manifest = androidManifest, host);
// { root, sdk, emulator, emulatorBin, platformTools, adbBin, images, image(id, abi), avd, home,
//   downloads, run, logs, settingsFile, devicesFile }
export function deviceEnvironment(paths, { adbPort, base = cleanEnvironment() });
// base plus HOME, ANDROID_SDK_ROOT, ANDROID_HOME, ANDROID_AVD_HOME, ANDROID_USER_HOME,
// ANDROID_EMULATOR_HOME, ANDROID_ADB_SERVER_PORT; any inherited ANDROID_* or ADB_* is dropped first

// devices/device-settings.js
export const DEVICE_LIMITS = { maxDevices: { default: 5, min: 1, max: 20 }, maxRunning: { default: 2, min: 1, max: 5 } };
export function readDeviceSettings(dataDir);         // a damaged file reads as defaults
export function writeDeviceSettings(dataDir, patch); // merges and validates; throws DEVICES_SETTINGS_INVALID (400)

// devices/android-sdk-install.js
export function installedSdk(paths, manifest, key);
// { emulator: version | null, platformTools: version | null, images: [id], current: boolean }
export async function ensureSdk({ paths, manifest, key, fetchImpl, run, env, signal, onProgress, keepImages = [] });
// installs or updates each component whose receipt is not the pinned sha256; resolves installedSdk()
export async function removeSdk(paths);
export function sweepSdk(paths);                     // stage folders an interrupted install left behind
export function pruneImages(paths, keep);            // removes images not in `keep`

// devices/android-sdk.js (style of runtimes/openclaw/semantic-memory.js)
export class AndroidSdk {
  constructor({ dataDir, manifest, host, changed = () => {}, inUse = () => false, imagesInUse = () => [],
                fetchImpl, run, now });
  recover();                                    // an install the last process did not finish -> failure INTERRUPTED
  status();                                     // see below
  available();                                  // null, or a host code, or DEVICES_NOT_INSTALLED
  install({ acceptTerms, by = "owner" });       // answers status() at once; work continues in the background
  cancel();                                     // aborts a running install; partial downloads stay
  remove();                                     // refuses DEVICES_IN_USE while inUse()
  resume();                                     // at server start: a pending request, or an installed SDK behind the pin
  async close();
}
```

`status()` answers:

```js
{ available, reason,                 // host codes only; "not installed" shows through state
  state: "absent" | "downloading" | "unpacking" | "checking" | "installed" | "removing" | "failed",
  updating: boolean,                 // an installed SDK is being brought to a new pin
  progress: null | { component: "emulator" | "platformTools" | "image", received, total },  // bytes over all components
  failure: null | { code, at, detail? },
  requested, terms: { accepted, acceptedAt, by },
  pinned: { emulator, platformTools, image: { id, api, tag, abi }, downloadBytes, diskBytes },
  installed: null | { emulator, platformTools, images },
  sources: manifest.hosts, licences: manifest.licences }
```

Codes for refusals and failures: `DEVICES_TERMS_REQUIRED` (400), `DEVICES_OPERATION_RUNNING`, `DEVICES_IN_USE`, `DEVICES_NOT_INSTALLED`, the three host codes, `DEVICES_DOWNLOAD_FAILED`, `DEVICES_DOWNLOAD_STALLED`, `DEVICES_DOWNLOAD_CANCELLED`, `DEVICES_CHECKSUM_MISMATCH`, `DEVICES_DISK_SPACE`, `DEVICES_ARCHIVE_INVALID`, `DEVICES_SDK_UNUSABLE` (with `detail.missing`, the libraries `ldd` reports as not found on Linux), `DEVICES_INTERRUPTED`, `DEVICES_INSTALL_FAILED`.

Rules the implementer cannot guess:

- **Order and staging.** Install platform-tools, then the emulator, then the image, each into `<sdk>/.stage-<uuid>` and renamed into place after its check.
- **Checks.** `adb version` must name 37.0.3 and `emulator -version` must name 37.3.10. On Linux, `ldd` on the emulator binary, as `checkBrowser` does in `chromium-installer.js`.
- **Space.** Before any download, `requireSpace` asks for the missing download bytes plus the expanded bytes plus 1 GiB.
- **Receipts.** A component directory without its receipt is not installed and is replaced.
- **Updates.** An update of the emulator or platform-tools needs no running device, so `ensureSdk` is called only while `inUse()` is false. A new image is installed beside the old one. `pruneImages` keeps the pinned image and every image a device record names (`imagesInUse()`).
- **Terms.** `install()` stores `terms` with the pinned versions. A later pin never asks again: `resume()` updates without `acceptTerms`.

**Steps:**

- [ ] Write the failing tests. Named assertions:
  - `pinned-download`: the moved function still passes the existing embedding test unchanged; with `prefix: "DEVICES"` the codes carry that prefix; a redirect to a host outside `hosts` is refused.
  - `android-sdk-install`:
    - installs all three components from the fake archives, and the receipts match;
    - a download that breaks after N bytes keeps `<file>.partial`, and a second `ensureSdk` sends a `Range` request and finishes (**review focus**);
    - a corrupted archive ends in `DEVICES_CHECKSUM_MISMATCH` and leaves no component directory;
    - `statfs` reporting too little space ends in `DEVICES_DISK_SPACE` before any request;
    - a write failing with `ENOSPC` during unpack ends in `DEVICES_DISK_SPACE`, leaves the earlier SDK intact and no stage folder (**review focus**);
    - a manifest with a new emulator version replaces only the emulator;
    - a new image id leaves the old image while `keepImages` names it and removes it afterwards;
    - `sweepSdk` removes stage folders only.
  - `android-sdk`:
    - `install()` without `acceptTerms` is `DEVICES_TERMS_REQUIRED`;
    - on an unsupported host it is the host code;
    - progress reaches `changed()` and `status().progress`;
    - `cancel()` ends in `absent` with the partial file kept;
    - a second `install()` while one runs is `DEVICES_OPERATION_RUNNING`;
    - `remove()` while `inUse()` is `DEVICES_IN_USE`;
    - `recover()` turns an unfinished install into `failed` with `DEVICES_INTERRUPTED`;
    - `resume()` starts a pending request and updates an installed SDK behind the pin without terms.
  - `device-settings`: defaults, bounds, and that a damaged file reads as defaults.
- [ ] Run: `node --test tests/unit/pinned-download.test.js tests/unit/android-sdk-install.test.js tests/unit/android-sdk.test.js tests/unit/device-settings.test.js tests/unit/embedding-assets.test.js`. Expect the new ones to fail.
- [ ] Implement the signatures above.
- [ ] Run again, then `npm run check:structure`.
- [ ] Commit: `feat: install the pinned Android SDK components with resumable downloads`.

## Task 5: Device source layer and the emulator source

**Files:**

- Create: `server/features/devices/device-source.js`, `server/features/devices/adb-client.js`, `server/features/devices/avd-files.js`, `server/features/devices/emulator-source.js`, `scripts/android-device-assets.mjs`
- Modify: `.github/workflows/nightly.yml` (a Linux x64 job for the contract, with what Task 1 found necessary for `/dev/kvm` and the SDK cached by the manifest's image id and emulator build), `docs/testing.md` (the fakes and the contract's environment variable)
- Test: `tests/unit/avd-files.test.js`, `tests/unit/adb-client.test.js`, `tests/integration/emulator-source.test.js`, `tests/integration/android-devices-contract.test.js`

**Interfaces**

Consumes: `devicePaths`, `deviceEnvironment` (Task 4); `androidManifest` (Task 2); the fakes (Task 3); `processIdentity` from `server/lib/process-identity.js`; the reclaim pattern of `runtimes/openclaw/embedding-server.js`.

Produces:

```js
// device-source.js: the contract every source implements; documented in JSDoc and checked by assertSource()
// availability()            -> null | reason code
// create(record)            -> Promise<void>       files exist afterwards; nothing boots
// start(record, { signal }) -> Promise<{ serial }> resolves when booted
// stop(record)              -> Promise<void>       saves the quick-boot snapshot
// reset(record)             -> Promise<{ image }>  factory state on the currently pinned image
// remove(record)            -> Promise<void>
// state(record)             -> { state, serial | null }
// diskBytes(record)         -> Promise<number>
// reclaim(records)          -> Promise<string[]>   ids whose leftover process was stopped
// close({ graceMs })        -> Promise<void>
// events: source.onExit = (id, { code, signal }) => {}
export function assertSource(source);

// adb-client.js
export class AdbClient {
  constructor({ paths, port, env, spawn });
  async startServer();     // the mode Task 1 chose; writes run/adb-server.json; throws DEVICE_ADB_FAILED
  async stopServer();      // only the server AgentPier started
  async reclaimServer();   // a leftover from an earlier process, verified by processIdentity
  exec(serial, args, { timeoutMs = 30000, maxBytes = 1048576, input, signal, encoding = "utf8" });
  // -> { stdout, stderr, code, truncated }; never throws for a non-zero exit; kills the child on timeout (DEVICE_ADB_TIMEOUT)
  async devices();         // [{ serial, state }]
}

// avd-files.js
export function avdConfig({ id, image, abi, shape }); // the key/value pairs Task 1 settled, as an object
export function writeAvd(paths, { id, image, abi, shape });
export function removeAvd(paths, id);
export function hasSnapshot(paths, id);

// emulator-source.js
export class EmulatorSource {
  constructor({ dataDir, manifest, host, adb, sdk, spawn, identity = processIdentity, now,
                bootTimeoutMs = 180000, stopGraceMs = 30000, pollMs = 500,
                adbPort = 47600, consolePorts = { first: 47602, last: 47620 } });
  // implements the contract above
}
```

Lifecycle codes thrown by the source: `DEVICE_UNAVAILABLE` (with `reason`), `DEVICE_PORTS_BUSY`, `DEVICE_ADB_FAILED`, `DEVICE_BOOT_TIMEOUT`, `DEVICE_EXITED` (with `exitCode`), `DEVICE_STOP_FAILED`, `DEVICE_DISK_SPACE`.

Rules:

- The emulator is spawned detached in its own process group with `deviceEnvironment`, the flags of Global Constraints, `-avd <id>` and `-ports <console>,<adb>`. Output goes to `logs/<id>.log`, which is truncated per start.
- The run record is written right after the spawn and removed when the process is gone.
- Boot wait: poll `getprop sys.boot_completed`. An exit of the process rejects at once with `DEVICE_EXITED`. At the timeout the process group is killed and the start rejects with `DEVICE_BOOT_TIMEOUT`.
- Stop: `emu kill`, wait up to `stopGraceMs`, then SIGTERM to the group, then SIGKILL after 5 s.
- `reclaim` handles each run record. It signals a process only if it is alive, has the recorded start time, and its executable's real path lies below the real path of `<data>/devices/sdk`. Any other pid is left alone and only the record is removed. A user's own emulator can therefore never match.
- The source addresses only serials it started. `adb.devices()` is never used to decide what to stop.
- `create` requires `manifest.shape`'s data partition size plus 1 GiB free space (`DEVICE_DISK_SPACE`).
- `reset` removes the AVD folder and writes it again on the currently pinned image.
- After a device's first boot (`record.provisioned === false`) the source runs the first-boot steps Task 1 decided (the Chrome first-run step, or none). It reports the result so the service can store `provisioned: true`.

**Steps:**

- [ ] Write the failing tests against the fakes. Named assertions:
  - `avd-files`: `writeAvd` produces `<id>.ini` with `path` and `target`, and a `config.ini` holding exactly the keys of Task 1; `image.sysdir.1` is relative to the SDK; `removeAvd` refuses an id that is not `^d-[a-f0-9]{12}$`.
  - `adb-client`: a non-zero exit is returned, not thrown; output above `maxBytes` is cut with `truncated: true`; a command slower than `timeoutMs` is killed.
  - `emulator-source`:
    - `start` resolves with `emulator-47602` and the launch record shows `HOME` under the data folder, the private adb port, no `-grpc`, and no inherited `ANDROID_SDK_ROOT`, even when the test sets one in `process.env` (**review focus**);
    - mode `die`: `start` rejects `DEVICE_EXITED` well before the timeout and leaves no run record (**review focus**);
    - mode `hang` with `bootTimeoutMs: 300`: rejects `DEVICE_BOOT_TIMEOUT` and the fake's pid is gone (**review focus**);
    - mode `stubborn`: `stop` ends the process through SIGKILL;
    - `stop` writes the snapshot marker and `hasSnapshot` is true;
    - a console port occupied by a test listener makes `start` use the next pair; with all pairs occupied, `DEVICE_PORTS_BUSY`;
    - a foreign listener on the adb server port ends in `DEVICE_ADB_FAILED` and the foreign listener is still alive afterwards (**review focus**);
    - `reclaim` stops a fake emulator left running by a source that was dropped without `close()` (**review focus**);
    - `reclaim` does not signal a pid whose executable lies outside the SDK (a `sleep` child written into a run record survives);
    - `reset` rewrites the AVD and names the pinned image.
  - `android-devices-contract` (native):
    - skips unless `AGENTPIER_ANDROID_CONTRACT_SDK` names a data folder with the installed pinned SDK and `hostProblem()` is null;
    - then, with the real emulator: create, cold start, `adb shell getprop ro.build.version.sdk` is `36`, stop, start again faster than the cold start (snapshot), reset, remove;
    - asserts: the listing of the real `~/.android` is unchanged; no process of ours listens on 5037; every listening socket of our processes is loopback; no process is left afterwards;
    - budgets go through `contractTimeout` from `tests/helpers/contract-timeout.js`.
- [ ] Run: `node --test tests/unit/avd-files.test.js tests/unit/adb-client.test.js tests/integration/emulator-source.test.js`. Expect failure.
- [ ] Implement the signatures above.
- [ ] Implement `scripts/android-device-assets.mjs` in the style of `scripts/assistant-embedding-assets.mjs`: `--root <dataDir>` installs the pinned SDK there from cache or network and writes `available=true|false` to `$GITHUB_OUTPUT`. A fetch failure is fatal only for a pull request that touches `server/features/devices/`, `scripts/android-device-assets.mjs` or the workflow.
- [ ] Add the nightly job. On pull requests that touch the feature the same job runs through a path filter.
- [ ] Run the tests again. Run the contract by hand on the Mac and on the test VM and note both results in the PR description.
- [ ] Commit: `feat: add the device source layer and the emulator source`.

## Task 6: Device service: records, lifecycle, limits, idle stop, queue, holds, access seam

**Files:**

- Create: `server/features/devices/device-store.js`, `server/features/devices/device-service.js`, `server/features/devices/device-admission.js`
- Test: `tests/unit/device-store.test.js`, `tests/unit/device-service.test.js`, `tests/unit/device-admission.test.js`

**Interfaces**

Consumes: a device source (the Task 5 contract; tests use an in-memory source that satisfies `assertSource`), `AndroidSdk` (Task 4), `readDeviceSettings` and `writeDeviceSettings` (Task 4), `SyncQueue` from `server/lib/sync-queue.js`.

Produces:

```js
// device-store.js
export class DeviceStore {
  constructor({ dataDir });
  list(); get(id);                                        // get throws DEVICE_NOT_FOUND (404)
  add({ name, creator, image });                          // id "d-" + 12 hex; DEVICE_NAME_INVALID (400), DEVICE_NAME_TAKEN (409)
  patch(id, changes); remove(id);
}
// name: trimmed, 1 to 40 characters, no control characters, unique without regard to case

// device-service.js
export class DeviceService {
  constructor({ dataDir, sdk, sources, now = Date.now, changed = () => {}, audit,
                idleMs = 900000, idleCapMs = 3600000, busyMs = 300000, sweepMs = 60000,
                creatorExists = () => true });
  async start();                       // reclaim leftovers, then the sweep timer
  async shutdown({ graceMs = 3000 });  // stop every device; bounded
  view();                              // what GET /api/devices answers
  settings(); configure({ maxDevices, maxRunning });
  async create({ name, creator });     // DEVICE_LIMIT_TOTAL (409), DEVICE_UNAVAILABLE (409, reason)
  async startDevice(id, { caller });   // resolves when running; DEVICE_LIMIT_RUNNING (409)
  async stopDevice(id, { caller });
  async reset(id, { caller });
  async remove(id, { caller });
  // seams for PRs 2 to 4
  async adb(id, args, { caller, start = true, timeoutMs, maxBytes, input, signal, encoding });
  devicesFor(caller);                  // [{ ...device view, manage: boolean }]
  permission(caller, id);              // { use: boolean, manage: boolean }
  registerGrants(kind, resolver);      // resolver(callerId) -> [{ deviceId, manage }]; kind "session" | "agent"
  registerAssignments(kind, lister);   // lister(deviceId) -> [{ kind, id, name, manage }], shown in view()
  hold(id, { ms });                    // -> { release(), extend(ms), until }; the owner holds the device
  heldUntil(id);                       // timestamp | null
  watch(id);                           // -> unwatch(); a viewer is looking
  onRemoved(listener);                 // (deviceId) => void, so later PRs drop their grants
}
// caller: { kind: "owner" } | { kind: "session", id } | { kind: "agent", id, ownerTurn?: boolean }

// device-admission.js: the pure decision
export function admit({ running, limit, now, busyMs, idleCapMs, wanted });
// running: [{ id, state, lastUse, viewers, held, queued }]
// -> { ok: true, evict: id | null } | { ok: false, code: "DEVICE_LIMIT_RUNNING" }
```

`view()` answers:

```js
{ availability: { available, reason },   // host codes or DEVICES_NOT_INSTALLED
  settings: { maxDevices, maxRunning }, counts: { total, running },
  devices: [{ id, name, source, state, operation: null | "reset" | "delete", failure: null | { code, at },
              creator: { kind, id, name, gone }, assignments: [], image: { id, current },
              diskBytes: number | null, held, viewers, createdAt, lastUsedAt }] }
```

Further codes: `DEVICE_BUSY` (409: another lifecycle operation runs on this device), `DEVICE_HELD` (409: the owner holds it and the caller is not the owner), `DEVICE_FORBIDDEN` (403: the caller may not use or manage it).

Rules:

- **Admission.** Every admission decision runs on one service-wide `SyncQueue`. The slot is reserved (state `starting`) before the boot is awaited.
- **Eviction.** A device is evictable when it is `running`, has no viewer, is not held, has no queued or running call, and was last used more than `busyMs` ago. The least recently used evictable device is stopped first; with none the start fails.
- **Serial queue.** `adb()` and every lifecycle operation of one device run on that device's own `SyncQueue`, one after another. `adb()` on a stopped device starts it first (`start: true`), sets `lastUsedAt`, and refuses `DEVICE_HELD` for a non-owner caller while a hold exists.
- **Permission.** The owner may do everything. A creator may use and manage its own device. Anyone else needs a grant from a registered resolver; `manage` is the "reset and delete" permission. In PR 1 only the owner calls.
- **Sweep.** Stops a running device idle for `idleMs`, or for `idleCapMs` while it has a viewer.
- **Source exit.** `onExit` for a device in `running` sets `failed` with `DEVICE_EXITED`.
- **Disk size.** `diskBytes` is measured after create, stop and reset and cached; never on a read.
- **Start.** `start()` calls `source.reclaim(records)`, then leaves every device `stopped`.
- **Shutdown.** `shutdown()` issues all stops at once and returns after `graceMs` at the latest.
- **Change signal.** `changed()` fires after every state write.
- **Removed SDK.** `sdk.remove()` deletes the devices too: the wiring calls `removeAll()` first, which requires all devices stopped.

**Steps:**

- [ ] Write the failing tests. Named assertions:
  - `device-store`: name rules, duplicate names without regard to case, a damaged file reads as empty, writes are atomic (no partial file after a simulated failure).
  - `device-admission`: below the limit, no eviction; at the limit with one idle device, that one; with all busy, viewed or held, the refusal; of two idle devices the least recently used.
  - `device-service`:
    - the sixth `create` is `DEVICE_LIMIT_TOTAL`;
    - `create` while the SDK is missing is `DEVICE_UNAVAILABLE` with reason `DEVICES_NOT_INSTALLED`;
    - **race, review focus:** with `maxRunning: 1` and two concurrent `startDevice` calls on two stopped devices, the source's `start` is called exactly once at a time and one call is refused with `DEVICE_LIMIT_RUNNING`;
    - **race, review focus:** with `maxRunning: 2`, one idle device running and two concurrent starts, exactly one eviction happens and at no moment do more than two devices count as running;
    - a viewed or held device is never evicted;
    - ten concurrent `adb()` calls on one device run strictly one after another (the fake source records overlap);
    - `adb()` on a stopped device starts it;
    - `adb()` by a session caller while `hold()` is active is `DEVICE_HELD`, and passes after `release()`;
    - a hold ends by itself after `ms`;
    - the sweep stops a device after 15 min, not while viewed, and stops it after 60 min even while viewed (manual clock from `tests/helpers/manual-timers.js`);
    - **restart, review focus:** `start()` calls `reclaim` with all records and afterwards no device is `running`;
    - **shutdown, review focus:** `shutdown({ graceMs: 50 })` returns within the bound although the fake source's stop never resolves;
    - a source exit turns `running` into `failed`;
    - `reset` keeps id, name and assignments and updates `image`;
    - `devicesFor({ kind: "session", id })` lists what a registered resolver grants plus the caller's own devices, with the right `manage`;
    - `remove` notifies `onRemoved`.
- [ ] Run: `node --test tests/unit/device-store.test.js tests/unit/device-admission.test.js tests/unit/device-service.test.js`. Expect failure.
- [ ] Implement the signatures above.
- [ ] Run again, then `npm run check:structure`.
- [ ] Commit: `feat: add the device service with limits, idle stop and a per-device queue`.

## Task 7: HTTP routes, live topics, wiring, shutdown

**Files:**

- Create: `server/http/routes/devices.js`, `server/features/devices/live-topics.js`, `server/application/device-wiring.js`
- Modify:
  - `server/app.js`: two lines, the import and `connectDevices(services, { mount, whenListening });`
  - `server/application/live-wiring.js`: define the two topics
  - `server/application/shutdown.js`: `await services.devices?.shutdown()` before `services.previews?.shutdown()`
  - `server/application/preview-wiring.js`: `internalPorts` adds the adb server port and the ports of running devices, so a preview can never forward to them
  - `web/lib/live/live-topics.js`: the two topics with a 5000 ms fallback interval
  - `docs/architecture.md`: Live channel, the two topics and that nothing is sampled
- Test: `tests/integration/devices-routes.test.js`, `tests/unit/device-wiring.test.js`; extend `tests/unit/live-topics.test.js` and `tests/unit/preview-wiring.test.js`

**Interfaces**

Consumes: `AndroidSdk`, `EmulatorSource`, `AdbClient`, `DeviceService`.

Produces:

```js
// device-wiring.js
export function createDevices(services);  // -> { devices, sdk }; signals the topics on every change
export function connectDevices(services, { mount, whenListening });
// sets services.devices and services.androidSdk, mounts the routes, and once listening runs
// sdk.recover(), sdk.resume() and devices.start(), each failure logged, never thrown

// live-topics.js (style of server/features/previews/live-topics.js)
export function devicesTopic(services);             // name "devices", owner only, read: services.devices.view()
export function deviceInstallationTopic(services);  // name "devices.installation", owner only, read: services.androidSdk.status()
export const devicesChanged = (hub) => hub?.invalidate("devices");
export const deviceInstallationChanged = (hub) => hub?.invalidate("devices.installation");
```

Routes, all owner only (the default of `server/http/route-access.js`) and all `Cache-Control: no-store`:

| Method and path                          | Body                         | Answer                                                  |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `GET /api/devices`                       |                              | 200, `view()`                                           |
| `POST /api/devices`                      | `{ name }`                   | 201, the device                                         |
| `POST /api/devices/:id/start`            |                              | 202, the device (the boot continues; the topic follows) |
| `POST /api/devices/:id/stop`             |                              | 202, the device                                         |
| `POST /api/devices/:id/reset`            |                              | 202, the device                                         |
| `DELETE /api/devices/:id`                |                              | 204                                                     |
| `PUT /api/devices/settings`              | `{ maxDevices, maxRunning }` | 200, the settings                                       |
| `GET /api/devices/installation`          |                              | 200, `status()`                                         |
| `POST /api/devices/installation/install` | `{ acceptTerms: true }`      | 202, `status()`                                         |
| `POST /api/devices/installation/cancel`  |                              | 202, `status()`                                         |
| `POST /api/devices/installation/remove`  |                              | 202, `status()`                                         |

A refusal with a stable code answers `{ code, error: code }` with the error's status (400, 403, 404 or 409). Anything else is thrown to the error handler.

**Steps:**

- [ ] Write the failing tests. Named assertions:
  - `devices-routes` (an app from `tests/helpers/application.js` with the fake SDK and fakes):
    - the installation routes go from `absent` through the install to `installed`;
    - `install` without terms is 400 `DEVICES_TERMS_REQUIRED`;
    - create, start, stop, reset and delete answer the documented status codes;
    - an unknown id is 404 `DEVICE_NOT_FOUND`;
    - `remove` with a running device is 409 `DEVICES_IN_USE`;
    - a subscriber to `devices` (`tests/helpers/live-hub-subscriber.js`) receives a new revision after start and after stop, and `devices.installation` receives progress;
    - a restricted user gets `unknown-topic` and 403 on the routes.
  - `device-wiring`: closing the application stops a running fake device and leaves no pid; a start with leftover run records reclaims them.
  - `preview-wiring`: `internalPorts` contains 47600 and a running device's two ports.
  - `live-topics`: `topicInfo("devices")` and `topicInfo("devices.installation")` name their routes, mode `state`, interval 5000.
- [ ] Run the four test files. Expect failure.
- [ ] Implement. Keep `server/app.js` within 600 lines (`npm run check:structure`).
- [ ] Update `docs/architecture.md`.
- [ ] Run the tests again.
- [ ] Commit: `feat: expose devices over HTTP and live topics`.

## Task 8: Installer flag and optional Linux packages

**Files:**

- Create: `server/features/devices/device-provisioning.js`
- Modify:
  - `scripts/setup.sh` (help text)
  - `scripts/install-bootstrap.sh` (both option lists)
  - `scripts/setup-options.mjs` (parse, result, `installerArguments`)
  - `scripts/setup-resume.mjs` and `scripts/release-install.mjs` (call the step, report its result, pass the option to `ensureDependencies`)
  - `scripts/install-dependencies.mjs`
  - `docs/installation.md`, `docs/linux.md`
- Test: `tests/unit/device-provisioning.test.js`; extend `tests/unit/setup-options.test.js` and the existing tests of `install-dependencies.mjs`, `setup-resume.mjs` and `release-install.mjs`

**Interfaces**

Consumes: `hostProblem`, `androidManifest`, `devicePaths`, `installedSdk`, `readDeviceSettings`, `writeDeviceSettings`.

Produces:

```js
// device-provisioning.js (style of server/features/tools/craft-provisioning.js)
export async function provisionAndroidDevices({ dataDir, enable = false, platform, arch, manifest, print = console.log });
// -> null (not asked, nothing there) | { status: "requested" | "installed" | "unavailable" | "failed", message? }
// enable on a supported host: prints what is downloaded (size, from dl.google.com) and the licence terms,
// stores requested: true and terms { by: "installer", acceptedAt, versions }; downloads nothing.
// The server installs at its next start (AndroidSdk#resume). Never throws.

// install-dependencies.mjs
export async function ensureDependencies({ ..., optional = {} });  // optional.androidDevices: boolean
// optionalLibraries entries gain `purpose` and `when` ("always" | "androidDevices"); the message of
// installOptional names the purpose. The Android set is the one Task 1 found, for linux x64 only.
```

Flag: `--with-android-devices`. The Linux packages are installed only when the flag is given or `settings.json` already has `requested` or an installed SDK. A headless server that never asked gets no GL or audio libraries.

**Steps:**

- [ ] Write the failing tests:
  - the flag parses and round-trips through `installerArguments`;
  - `provisionAndroidDevices` writes the request and the terms on a supported host, and prints the licence names and the download size;
  - it returns `unavailable` with a message on `linux-arm64` and on Linux without `/dev/kvm`, and writes nothing;
  - it returns `installed` when the receipts match;
  - it returns `failed` with a message, without throwing, when the data folder is a link;
  - `ensureDependencies` asks for the Android packages only with `optional.androidDevices`, and a refused `sudo` is no error.
- [ ] Run the tests. Expect failure.
- [ ] Implement.
- [ ] Docs: `docs/installation.md` (the flag, what it downloads and when, the terms, removal) and `docs/linux.md` (KVM, the `kvm` group with the exact command, the packages, nested virtualization in a VM). `docs/linux.md` is still German; small edits stay German.
- [ ] Run the tests again, and `sh -n scripts/setup.sh scripts/install-bootstrap.sh`.
- [ ] Commit: `feat: add the --with-android-devices installer flag`.

## Task 9: The owner's device list, install dialog, search entries, docs

**Files:**

- Create:
  - `web/features/devices/DevicesPage.jsx`, `DeviceInstallCard.jsx`, `DeviceInstallDialog.jsx`, `DeviceRows.jsx`, `DeviceCreateDialog.jsx`, `device-view.js`, `useDevices.js`
  - `web/lib/i18n/de/devices.js`, `web/lib/i18n/en/devices.js`, `web/lib/i18n/messages/devices.js` (export `devicesCopy`)
  - `tests/helpers/devices-fixture.js`
  - `docs/devices.md`
- Modify:
  - `web/features/operations/routes.js`: section `devices` in `sections` and in `settingsSectionGroups.general`
  - `web/features/settings/SettingsSubpage.jsx`: the lazy page
  - `web/features/settings/WorkspaceTab.jsx`: one row in the Features group that opens the page and shows its state
  - `web/app/search-entries.js`, `web/lib/i18n/translation-lock.json`
  - `docs/backups.md` (devices are not in backups), `docs/ui-glossary.md` if it lists settings pages, `docs/README.md` (link the guide), `README.md` and `README.de.md` (one feature line each)
- Test: `tests/unit/device-view.test.js`, `tests/browser/devices.spec.js`; extend `tests/unit/search-index.test.js`, `tests/unit/quick-open.test.js`; one assertion in the backup plan's existing test that no member path starts with `devices/`

**Interfaces**

Consumes: the routes and topics of Task 7 and their exact shapes; `useLiveTopic` from `web/lib/live/useLiveTopic.js`; `ListCard`, `ListRow`, `GroupLabel`, `NumberRow`, `StatusChip`, `Modal`, `ConfirmDialog`, `AsyncForm`, `ErrorMessage`, `SaveBar` from `docs/ui-guide.md`.

Produces:

```js
// device-view.js: pure, tested without a browser (style of hub/semantic-memory-view.js)
export function installationView(status, bytes);
// -> { tone, state, running, progress, alert, actions: [{ kind: "install" | "cancel" | "remove" | "retry", label, disabled, hint }] }
export function deviceRowView(device, { availability });
// -> { tone, stateText, sub, actions: [{ kind: "start" | "stop" | "reset" | "delete", disabled, hint }] }
export function codeText(code, detail);  // every code of Tasks 2, 4, 5 and 6 in words; an unknown code shows itself
```

UI decisions:

- **Page.** "Android devices" / "Android-Geräte" at `/settings/devices`.
- **Group "Installation".**
  - State chip, progress in bytes, and the failure in words.
  - Install opens `DeviceInstallDialog`. It names what is downloaded (the pinned versions, about 6 GB, from dl.google.com), the licence links from `status.licences`, and that the owner accepts them. Its primary button sends `acceptTerms: true`.
  - Remove is a `ConfirmDialog` that names the number of devices it deletes.
  - On an unavailable host the group shows the reason text and no install button. `DEVICES_KVM_DENIED` names the `kvm` group; `DEVICES_KVM_MISSING` names virtualization.
- **Group "Devices".**
  - One row per device: name, state, creator (with "creator no longer exists" when `gone`), assignments (empty in PR 1; render the list so PRs 2 and 3 only fill it), size on disk, and the actions.
  - Reset and Delete each ask through a `ConfirmDialog`.
  - "New device" opens `DeviceCreateDialog` (one name field).
  - There is no "open view" button yet; PR 4 adds it.
- **Group "Limits".** Two `NumberRow`s with a `SaveBar`.
- **Search entries.** A page entry `settings-devices` under Settings › General with aliases (Android, Emulator, Phone, Handy, Telefon, Smartphone); group entries for Installation and Limits; an action "New device" that opens the page with `pending: "device-create"`, consumed by `usePageAction`.
- **Catalog.** `devices`. Every code has a German and an English text with the same interpolation arguments.

**Steps:**

- [ ] Write the failing tests:
  - `device-view`: one case per installation state and per device state; every code from the lists in Tasks 2, 4, 5 and 6 has a text in both languages (iterate the code lists, so a new code without text fails); the two KVM reasons differ and the denied one contains "kvm".
  - Search: "android", "emulator" and "Handy" find the page in both languages and its path is `/settings/devices`; "new device" offers the action.
  - `devices.spec.js` with the live stub (`tests/helpers/live-stub.js`) and `devices-fixture.js`:
    - an unavailable host shows the reason and no install button;
    - the install dialog needs the accept action and then shows progress pushed over `devices.installation`;
    - a device row changes from Starting to Running on a pushed `devices` value without any request;
    - a failed device shows its reason;
    - delete asks for confirmation;
    - the page works in English (switch the language in the test).
- [ ] Run: `node --test tests/unit/device-view.test.js tests/unit/search-index.test.js tests/unit/quick-open.test.js`. Expect failure.
- [ ] Implement the page, catalogs and entries.
- [ ] Run `npm run i18n:confirm -- devices` after reviewing each German and English pair; commit the lock file.
- [ ] Write `docs/devices.md`: what it is, the supported hosts, install and remove, the terms, limits and idle stop, memory and disk per device from the spec's table, that a device reaches the network and the host's loopback, that devices are not in backups, and troubleshooting by reason code. Update the other docs listed above.
- [ ] Run `npm run build`, the three unit files, `tests/unit/i18n-catalogs.test.js`, `tests/unit/i18n-translation-lock.test.js`, `tests/unit/ui-guide-rules.test.js`, and `npx playwright test tests/browser/devices.spec.js`.
- [ ] Exercise the page once against a real install on the Mac (install, create, start, stop, reset, delete) in English and take the screenshots for the PR.
- [ ] Run `npm run check`.
- [ ] Commit: `feat: add the owner's Android device list and installation dialog`.

---

## What PRs 2 to 4 consume from PR 1

- **Run an adb command on device X:** `services.devices.adb(id, args, { caller, timeoutMs, maxBytes, input, encoding })`. It is queued per device, starts a stopped device, bounds output and time, and updates the last use.
- **Which devices may caller Y use:** `devicesFor(caller)` and `permission(caller, id)`. PR 2 calls `registerGrants("session", …)` and `registerAssignments("session", …)` from its grant store; PR 3 does the same for `"agent"` and for member grants. Both listen to `onRemoved` to drop grants.
- **Create, reset and delete by agents and sessions:** `create({ name, creator })`, `reset(id, { caller })`, `remove(id, { caller })` already check `manage` and the creator. PR 2 adds the per-session "create devices" permission before calling `create`. PR 3 adds the owner-turn rule and the foreign-content gate before any call.
- **Refuse while the owner holds the device:** `hold(id, { ms })` and the `DEVICE_HELD` refusal inside `adb()`. PR 4 builds the 10-minute lease with its warning on `hold().extend`, and the takeover link.
- **Viewers:** `watch(id)` keeps a viewed device from eviction and applies the 60-minute cap. PR 4's WebSocket calls it per connection and takes screenshots through `adb()` with `encoding: "buffer"` and `caller: { kind: "owner" }`.
- **State in the UI:** the `devices` topic and `useDevices()` serve the strips in agent chats and sessions; `assignments` in the view is already rendered.
- **Other sources:** a real phone or redroid implements the contract of `device-source.js` and is added to `sources`; records carry `source`.
- **First-boot steps:** the hook from Task 5 is where a later on-device helper is installed (AGENTPIER-514).

## Task 1 findings

(Filled in by Task 1: config.ini key set, zip top folders and sizes, redirect hosts, adb server mode, port decision, screen decision, Chrome first-run decision, Linux package set, KVM on GitHub runners.)

## Decisions on the planner's open questions (orchestrator, 2026-11-28)

1. **Loopback adb is not an access boundary.** Accepted for PR 1. `docs/devices.md` states it: any program of the same host user that reaches loopback can talk to AgentPier's adb server and a running device; assignments decide which tools AgentPier offers, they do not isolate the device from other local processes. PR 2 checks what the session sandbox allows on loopback and documents the result.
2. **Removing the installation deletes all devices**, after a confirmation that names the count. Confirmed.
3. **Audit log: yes.** Task 7 writes install, remove, create, reset and delete by any caller to the audit log, with `audit-actions` entries in both languages, as previews do.
4. **Storage overview: yes.** Task 9 adds a `devices` data area to `server/features/system-status/data-areas.js` with its texts and test.
5. **Ports stay fixed** (no setting). `DEVICE_PORTS_BUSY` gets a text that names the range. No change to the preview range validation.
6. **Index file name:** Task 2 uses whichever index lists revision 7 and records it in the manifest header.
7. **Homebrew:** Task 8 checks `scripts/install-homebrew.sh` and the formula and passes the flag through where the other `--with-*` flags are passed.
8. **KVM on CI:** do not push a throwaway workflow in Task 1. GitHub's Linux x64 runners are documented to offer `/dev/kvm` after a udev rule grants access; Task 5 adds that rule to the job and the pull request's own CI run is the check. If it does not work there, drop the job and say so in the pull request.
