# Android devices

Android devices are emulated Android phones that run on the AgentPier host, in Google's
Android Emulator. They exist so that agents and coding sessions can test apps and
websites on a phone. This version provides the installation, the devices and their
lifecycle; the tools for sessions and agents and the owner's live view of a device
follow in later versions.

Everything is under **Settings › General › Android devices** (`/settings/devices`), for
the owner only. ⌘K finds the page as "Android", "Emulator", "Phone" or "Handy", and
offers **New device**.

## Supported hosts

| Host                    | Supported                                                    |
| ----------------------- | ------------------------------------------------------------ |
| macOS on Apple silicon  | Yes                                                          |
| Linux x64               | Yes, with KVM usable by the account AgentPier runs as        |
| Intel Macs, Linux arm64 | No: Google provides no emulator build AgentPier can use here |

On a host that cannot run devices the page says why and offers no installation; nothing
else changes there. Linux needs `/dev/kvm` and two X11 libraries even without a window;
see [Linux › Android devices](linux.md#optional-android-geräte).

## Install and uninstall

**Install …** downloads three pinned components from `dl.google.com` into
`<data dir>/devices/sdk`: the Android Emulator, the Android SDK Platform-Tools (adb) and
one Google APIs system image for Android 16 (API 36, without the Play Store). The
download is about 2.3 GB and takes 5.5 to 5.9 GB on disk; the page counts in binary
units and shows 2.2 GB and 5.5 GB. No Java, no Android Studio and no `sdkmanager` are
involved, and nothing is installed outside the data directory.

- The download is resumable. After an interruption, **Try again …** continues where it
  stopped, and each archive is used only when its size and SHA-256 match the pinned
  values.
- The page shows the running step (downloading, unpacking, checking) with the bytes
  received. **Cancel installation** stops it and keeps what is downloaded.
- The installer option `--with-android-devices` requests the same installation; the
  next start of AgentPier downloads it ([installation](installation.md)).
- A later AgentPier version may pin newer components. They are updated at the next
  start while no device runs, or with **Update …** on the page. If an update fails, the
  installed version stays in use and the page shows the failure beside it. A new system
  image is used for new devices; an existing device keeps its image until it is reset.
- **Uninstall …** deletes the components **and every device**, after a confirmation
  that names how many devices that is. It is refused while a device starts, runs,
  stops, or is being reset or deleted; while it runs, nothing can be started or
  created.

### Terms

Google provides the components under the Android Software Development Kit License
Agreement; the arm64 system image used on macOS adds terms of Arm Limited. The install
dialog links them, and its confirming button, **Accept and install**, is the acceptance.
AgentPier stores the time and the pinned versions with it and does not ask again for a
later version of the same components. The installer option counts as acceptance and
prints the same terms. AgentPier redistributes none of these files
([third-party notices](../THIRD_PARTY_NOTICES.md)).

## Devices

**+ New device** creates a device from a name (1 to 40 characters, unique). Every device
has the same shape: a phone with Android 16, 720 × 1600 pixels at 320 dpi, 4 cores and
2 GB of guest memory.

| Action       | What happens                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Start**    | Boots the device: about 30 to 55 s the first time, about 3 s afterwards from its saved state. The row shows **Starting**, then **Running**.                                    |
| **Stop**     | Shuts the device down and saves its state for the next start. A device that is still starting is stopped at once; **Reset …** and **Delete …** do not wait for a start either. |
| **Reset …**  | Back to the factory state: apps, logins and files on the device are deleted; its name and who may use it stay. Asks first.                                                     |
| **Delete …** | Deletes the device and everything on it. Asks first.                                                                                                                           |

A row also shows who created the device (you, an agent or a session; "creator no longer
exists" when that agent or session is gone), who it is assigned to, and its size on
disk (measured while the device is stopped, so a running device shows none). A device that failed shows the reason in words; see
[Troubleshooting](#troubleshooting).

Resources, measured with the pinned emulator:

|                                | macOS on Apple silicon | Linux x64 with KVM |
| ------------------------------ | ---------------------- | ------------------ |
| Host memory per running device | 5 to 6 GB              | about 3.4 GB       |
| Components on disk             | about 5.5 GB           | about 5.2 GB       |
| Per device on disk             | 3.7 to 4.3 GB          | about 3.7 GB       |
| First boot                     | 30 to 37 s             | 52 to 55 s         |
| Later starts                   | about 3 s              | about 3 s          |

## Limits and automatic stop

Two limits, both under **Limits** on the page:

- **Devices in total**: 5 by default, 1 to 20.
- **Devices running at once**: 2 by default, 1 to 5. At the limit, starting another
  device stops the running device that was unused longest, unless every running device
  is in use; then the start is refused and says so.

A running device stops by itself after 15 minutes without use. All devices stop when
AgentPier stops, and a device left running by a crashed AgentPier is stopped at the next
start. After such an unclean end the device boots cold once, so that nothing written
since its last saved state is lost.

## What a device can reach

- **The network and the host's loopback.** A device reaches the network like any
  program on the host, including services that listen only on the host's loopback
  (inside the device, `10.0.2.2` is the host). That is intended, for testing a local
  development server on a phone; treat giving someone a device like giving them a
  shell on the host's network.
- **Loopback adb is not an access boundary.** AgentPier runs its own adb server on
  `127.0.0.1:47600` and each running device listens on two loopback ports from
  `47602` to `47621`. Any program of the same host account that reaches loopback can
  talk to that adb server and to a running device. Assignments decide which tools
  AgentPier offers to an agent or session; they do not isolate a device from other
  local processes.
- **Nothing listens beyond loopback**, and the emulator's unauthenticated gRPC endpoint
  stays off.
- **Your own Android setup stays untouched.** The emulator and adb run with their own
  home, SDK and adb key below `<data dir>/devices`, never with `~/.android`, the default
  adb port 5037 or an SDK elsewhere on the machine.
- **The service's environment is not handed on**, except what a program needs to run:
  the emulator and adb get neither the SSH agent's socket (`SSH_AUTH_SOCK`) nor the
  display of a desktop session (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`). The proxy
  variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) are handed on, because the
  device's network and the emulator's own requests may need them; a device therefore
  uses the proxy AgentPier itself was started with.

## Files

Everything lives below `<data dir>/devices`, readable by the AgentPier account only:
`sdk` (the components), `avd` (the devices), `home` (adb keys and emulator state),
`downloads`, `run`, `logs` (the emulator output of each device's last start),
`settings.json` and `devices.json`. **System status › Storage** lists it as **Android
devices**.

If `devices.json` cannot be read at a start (cut off by a crash, edited by hand),
AgentPier keeps it as `devices.json.damaged-<time>`, says so in the server log, and
lists every device whose folder exists under `avd` again as **Recovered device 1**,
**2** and so on, created by you. Their contents are untouched; names, creators and
assignments are lost, so rename the devices or delete the ones you do not need. The
kept file is yours to inspect and delete.

Two things the emulator writes elsewhere and AgentPier cannot redirect: its crash
database under `/tmp/android-<account>/`, and on Linux `netsimd` logs in the same folder.

**Devices are not part of backups.** Neither the components nor any device is in a
backup or restored from one ([backups](backups.md)): the components are a download, and
a device is several gigabytes of emulator state. After a restore on a new host, install
the components and create the devices again.

## Troubleshooting

The page shows each of these in words; the codes appear in the audit log, the server
log and the installer's result.

| Code                                                   | Meaning and what to do                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICES_PLATFORM_UNSUPPORTED`                         | No emulator build for this host. Use macOS on Apple silicon or Linux x64.                                                                                                                                                         |
| `DEVICES_KVM_MISSING`                                  | Linux has no `/dev/kvm`. Turn on hardware virtualization in the firmware, or nested virtualization for a virtual machine.                                                                                                         |
| `DEVICES_KVM_DENIED`                                   | AgentPier may not open `/dev/kvm`. Add its account to the `kvm` group (`sudo usermod -aG kvm <name>`), sign that account in again and restart AgentPier.                                                                          |
| `DEVICES_SDK_UNUSABLE`                                 | The downloaded emulator does not start. On Linux install `libx11-6` and `libx11-xcb1`; the page names the missing libraries when the system reports them. Then **Try again …**.                                                   |
| `DEVICES_DOWNLOAD_FAILED`, `DEVICES_DOWNLOAD_STALLED`  | The download broke off or stopped making progress. Check the connection to `dl.google.com` and **Try again …**; it continues.                                                                                                     |
| `DEVICES_CHECKSUM_MISMATCH`, `DEVICES_ARCHIVE_INVALID` | A downloaded archive was not the pinned one or could not be unpacked. It was discarded; **Try again …**.                                                                                                                          |
| `DEVICES_DISK_SPACE`, `DEVICE_DISK_SPACE`              | Too little free space for the components or for another device. Free up space or delete a device.                                                                                                                                 |
| `DEVICES_INTERRUPTED`                                  | AgentPier stopped during the installation. **Try again …** continues the download.                                                                                                                                                |
| `DEVICES_INSTALL_FAILED`                               | The installation or removal failed for another reason. Try again; check the free space and the server log.                                                                                                                        |
| `DEVICES_IN_USE`, `DEVICES_OPERATION_RUNNING`          | A device runs, or the components are being installed, updated or removed. Stop the devices, or wait.                                                                                                                              |
| `DEVICE_LIMIT_TOTAL`, `DEVICE_LIMIT_RUNNING`           | A limit is reached. Delete or stop a device, or raise the limit.                                                                                                                                                                  |
| `DEVICE_BOOT_TIMEOUT`                                  | The device did not finish booting within 3 minutes. Start it again; if it keeps failing, reset it.                                                                                                                                |
| `DEVICE_EXITED`                                        | The emulator ended by itself, during the boot or while running. Start the device again; `<data dir>/devices/logs/<id>.log` holds its last output.                                                                                 |
| `DEVICE_PORTS_BUSY`                                    | Another program uses AgentPier's loopback ports 47600 to 47621. Close it and start the device again. The ports are fixed.                                                                                                         |
| `DEVICE_IMAGE_MISSING`                                 | The system image a new or reset device needs is not installed, usually because an update of the components has not run yet. Update the installation, then try again. A device on an earlier image still starts until it is reset. |
| `DEVICE_ADB_FAILED`, `DEVICE_ADB_TIMEOUT`              | AgentPier could not reach the device through adb. Stop the device and start it again. When the page says that port 47600 is used by another program, see "A second AgentPier on the same machine" below.                          |
| `DEVICE_STOP_FAILED`                                   | The device did not stop. The row keeps **Stop**: use it again (reset and delete try the stop again too); restarting AgentPier ends what is left of it.                                                                            |

Also worth knowing:

- **An emulator of your own on the same machine.** The emulator's Bluetooth helper
  `netsimd` listens on the fixed loopback port 6402. An emulator you start yourself
  (Android Studio) uses the same port, so the two may collide or share one helper.
  Stop one of them if a device fails to start while your own emulator runs.
- **A second AgentPier on the same machine.** The adb port 47600 and the device ports
  are fixed, so only one AgentPier per machine can run devices at a time (a stage
  instance beside the installed service, for example). The second one never ends the
  first one's adb server: AgentPier ends only an adb server of its own data
  directory, and one it cannot identify (the `lsof` or `ss` program is missing) it
  leaves alone as well. Its devices then fail to start and say that the port is used
  by another program. Stop the devices of the other instance, or that instance.
- **Memory.** A running device takes 3 to 6 GB of host memory. Lower **Devices running
  at once** on a small host.
- **Restricted users** do not see the page; for them its routes answer like unknown
  ones.
