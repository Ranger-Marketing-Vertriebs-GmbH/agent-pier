# Android devices

Android devices are emulated Android phones that run on the AgentPier host, in Google's
Android Emulator. They exist so that agents and coding sessions can test apps and
websites on a phone. This version provides the installation, the devices and their
lifecycle, and the tools for coding sessions and for agents; the owner's live view of
a device follows in a later version.

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
exists" when that agent or session is gone, also a deleted agent; the device stays),
who it is assigned to, and its size on disk (measured while the device is stopped, so
a running device shows none). Agents and sessions are named as they are called now
("Assigned to agent Home (may reset and delete), session Checkout"), with "(may reset
and delete)" where you allowed it. A team member that uses the device because its
lead passed it on reads "agent Scout (passed on by Home for a task)"; that entry
leaves the row when the task has ended. A device with more than three assignments
names three and counts the rest ("and 2 more"). The full choice is in each agent's
**Access** tab and in each session's **Android devices** dialog. A device that failed shows the reason in words; see
[Troubleshooting](#troubleshooting).

Resources, measured with the pinned emulator:

|                                | macOS on Apple silicon | Linux x64 with KVM |
| ------------------------------ | ---------------------- | ------------------ |
| Host memory per running device | 5 to 6 GB              | about 3.4 GB       |
| Components on disk             | about 5.5 GB           | about 5.2 GB       |
| Per device on disk             | 3.7 to 4.3 GB          | about 3.7 GB       |
| First boot                     | 30 to 37 s             | 52 to 55 s         |
| Later starts                   | about 3 s              | about 3 s          |

## Devices for coding sessions

A coding session (Claude Code, Codex, OpenCode) uses a device through tools that
AgentPier adds to it, once you assigned the device to that session. Nothing is shared
by default: a session sees no device until you give it one.

Where you assign devices:

- **New session › Extensions › Android devices.** The section lists the devices you
  added, each with a remove button, and ends in the **Add Android device** field.
  Below it, **Permissions** holds one switch **Reset and delete "<device>"** per added
  device and the switch **Create devices**. The section appears for coding CLIs while
  the Android components are installed and this host can run devices; a shell, a
  launch from a task profile and a host without devices show none. Started without
  **AgentPier tools**, the section says that the session gets no device tools.
- **Android devices** in a running coding session's header (the phone icon; on a
  phone in its **More actions** menu), and in the search (⌘K / Ctrl+K) as
  "<session> · Android devices". Search the devices on the left and check the ones the
  session may use; the right side lists the allowed devices and the same
  **Permissions** (on a phone it is one checklist with the permissions below).
  **Save** applies the change at once, without a reload; a change made elsewhere
  shows in the open dialog. A device the session created is listed as allowed with
  "created by this session" and cannot be taken away. A session that runs without
  AgentPier tools says so: the assignment is saved, but the session gets the device
  tools only after a reload with AgentPier tools, and a session started without them
  needs a new session.

What the choices mean:

- **Assign devices** when you start a session and at any time while it runs. Several
  sessions may have the same device; their calls on it run one after another.
- **Reset and delete** is a separate permission per assigned device, off by default.
  Without it a session uses the device but can neither wipe nor delete it. A device
  you remove from a session and add again starts without it.
- **Create devices** is a permission per session, off by default. A device a session
  created is its own: it may use, reset and delete it without further permission. It
  appears in your device list with the session as its creator, counts towards
  **Devices in total**, and you can assign it to other sessions or delete it. Device
  names are unique on the host, so a session with this permission learns that a name
  is taken (`DEVICE_NAME_TAKEN`) also when the device of that name is not assigned to
  it; it needs the reason to choose another name. That is accepted: you trust such a
  session with creating devices, and their names are not secret from it. A session
  without the permission learns no names: a name it was not given answers
  `DEVICE_NOT_FOUND`, like one that does not exist.
- **When the session is removed**, its assignments go with it. Devices it created
  stay and show "creator no longer exists"; you decide what happens to them. Stopping
  a session keeps its assignments, and a stopped session can call nothing.
- **Which sessions:** your own running coding sessions with **AgentPier tools**. Not
  sign-in, pipeline, shell or imported sessions, not a session that an agent of a
  restricted user started, and no external MCP client.
- **While you hold a device** (the owner's view, in a later version), a session's
  calls on it are refused until you hand it back.
- **Audit log.** Each change you save in a session's **Android devices** is recorded
  as `session.updated` with the kind `device-grants` (the session and the outcome,
  never the devices); a launch is `session.started` as always.

The tools appear in a session while the Android components are installed and this
host can run devices; a device you assign later needs no reload. They are listed with
their arguments in [MCP › Android devices from sessions](mcp.md#android-devices-from-sessions).
What a session can do with an assigned device:

| Tools                                                                   | What they do                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `devices_list`, `device_create`, `device_start`, `device_stop`          | See its devices, create one (with the permission), start and stop. A stopped device starts by itself when a tool uses it. |
| `device_reset`, `device_delete`                                         | Factory state, or gone. Only with **Reset and delete** or on a device the session created.                                |
| `device_screenshot`, `device_ui`                                        | The screen as a PNG, or as a numbered list of what is on it (text, type, position, what can be tapped).                   |
| `device_tap`, `device_swipe`, `device_key`, `device_type`               | Tap an element by its number or a point, long-press, scroll and swipe, press a key, type text.                            |
| `device_install`, `device_app_launch`, `device_app_stop`, `device_apps` | Install an APK, start and stop apps, list them.                                                                           |
| `device_open_url`, `device_logs`                                        | Open a URL in Chrome or in the app that handles it; read the device's recent log.                                         |
| `device_push`, `device_pull`                                            | Copy a file to the device, or from it.                                                                                    |
| `device_shell`                                                          | Run a shell command inside the device.                                                                                    |

Limits of this version, each said to the session when it runs into one:

- **Typing is ASCII only.** Text with umlauts, accents, emoji or line breaks is
  refused as a whole (`DEVICE_TEXT_UNSUPPORTED`); the Enter key is `device_key`.
- **The overview takes 2 to 3 seconds** and lists at most 150 elements or 16 KB. An
  element's number is valid until the next overview; after a stop, a restart or a
  reset of the device it is refused (`DEVICE_ELEMENT_STALE`).
- **Sizes:** up to 200 MB to a device (an APK too), up to 50 MB from it, a
  screenshot of up to 4 MB, 64 KB of shell or log output (cut, with a note).
- **Time:** a shell command ends after 30 seconds unless the session asks for more,
  at most 120; a call as a whole ends after 140 seconds, also while a device is still
  booting, which then goes on.

### Files stay in the session's working folder

A file a session installs, pushes or pulls is named by a path on the host. That path
must lie inside the session's working folder (its project folder or worktree):

- The working folder is the folder itself, not its path. AgentPier records the
  folder's real path and its device and inode numbers when the session's CLI starts,
  and a file travels only while the folder at that path is still that folder. A
  session that can write the folder above its own could otherwise move its folder
  away and put a link to another place there. A folder that was moved, replaced by a
  link or by another folder, or deleted and created again is refused
  (`DEVICE_PATH_OUTSIDE`, with the hint to reload); see below for what to do.
- AgentPier resolves the real path, following every link. A link that leads to
  another place inside the folder is fine; a real path outside is refused
  (`DEVICE_PATH_OUTSIDE`), and so is anything in AgentPier's own data folder and a file
  with a second name (a hard link).
- The file is then opened from the folder's root without following any link, so a
  name that was swapped for a link after the check fails instead of leading out.
- A pulled file replaces a regular file of the same name; a link or a folder in its
  place is refused, never followed.
- A pulled file is read on the device as one stream of at most 50 MB (the output of
  the device's `cat`), so a path that names a folder, or a file that keeps growing,
  never fills the host's disk; a folder is refused (`DEVICE_FILE_NOT_FOUND`). A call
  that ended at its time limit, or whose session is gone, writes nothing afterwards.
- adb never gets a path of the folder: AgentPier copies the file to or from a private
  folder below `<data dir>/devices/run/transfers` and removes that copy afterwards.

When the working folder itself changed:

- **A worktree, a checkout, a build, `git init`** change what is in the folder, not
  the folder: nothing to do.
- **The folder was deleted and created again** (a worktree removed and added at the
  same path, a fresh clone over the old one) or moved away: `device_install`,
  `device_push` and `device_pull` are refused until you **reload the session**. A
  reload starts the CLI in the folder its path names at that moment, and that folder
  is the working folder from then on. Putting the original folder back works too.
- **A session started before AgentPier recorded the folder** (before this version) has
  none on record: its file tools are refused until its first reload. The other device
  tools work as before.

Reload a session only when you know what its path names now: a reload is your word
that the session works in that folder, for the device tools as for the CLI itself.

A session in a [sandbox](sandbox.md) therefore cannot make AgentPier, which runs
outside it, read files beyond its working folder. Two things follow from AgentPier
not knowing what a nono profile allows:

- **`device_pull` is refused in a sandboxed session** (`DEVICE_PULL_SANDBOXED`). nono
  gives the working folder read-only unless the profile says otherwise, and a file
  written there by AgentPier would get around that. The session can read a file's
  content with `device_shell` and write it itself, where its sandbox lets it.
- **`device_install` and `device_push` read any file of the working folder**, also
  one that the profile denies inside that folder, and the session can read it back
  from the device. Artifacts published by a session behave the same.

### The shell runs in the device

`device_shell` is `adb shell`: the command runs inside the emulated phone as its
`shell` user, with what that user may do there (settings, permissions, `dumpsys`, the
package manager, intents). It never runs on the host. AgentPier starts adb with a list
of arguments and no shell of its own, and passes the command as one of them; the
other tools build their commands from checked values (a package name, a key from a
fixed list, coordinates) and quote everything else as one word.

"Inside the device" is still not "isolated": a device reaches the network and the
host's loopback (see [What a device can reach](#what-a-device-can-reach)). Give a
session a device as you would give it a shell on your network. That holds for a
[sandboxed](sandbox.md) session too, whatever its profile says about the network: the
device is outside its sandbox.

### What a device shows is untrusted

A screen, a UI text, a log line, a pulled file and the output of an app or a shell
command come from the device and from whatever it loaded, a web page included. The
tools say so in their descriptions, and a session should read such content as data,
never as instructions. Keep that in mind before you let a session with other
permissions (SSH, secrets, pipelines) browse pages you do not control.

## Devices for agents

An agent of yours (on OpenClaw or Hermes) uses a device through its tool
`agentpier_device`, once you assigned the device to that agent. Nothing is shared by
default. The tool does what a coding session's tools do (the table under
[Devices for coding sessions](#devices-for-coding-sessions)), as one tool with an
`action`: `list`, `create`, `start`, `stop`, `reset`, `delete`, `screenshot`, `ui`,
`tap`, `swipe`, `key`, `type`, `install`, `push`, `pull`, `app_launch`, `app_stop`,
`apps`, `open_url`, `logs` and `shell`, with the same arguments and sizes. An
agent's call ends after 110 seconds as a whole (a session's after 140), also while a
device is still booting, which then goes on; so an agent's `shell` takes a `timeoutMs`
of at most 100000 (a session's 120000). A screenshot reaches the agent's model as an image.

You assign devices in the agent's settings, **Agents › <agent> › Access › Android
devices**, at the end of the tab's groups (in the search, ⌘K / Ctrl+K, as "<agent> ·
Android devices"). The group shows while the Android components are installed and
this host can run devices:

- **Allowed for this agent · n** lists the devices the agent may use, each with a
  remove button, and ends in the **Add Android device** field. A device the agent
  created is listed with "created by this agent" and cannot be taken away.
- **Permissions** holds one switch **Reset and delete "<device>"** per added device
  and the switch **Create devices**, all off unless you turn them on. A device an
  agent created is its own: it may use, reset and delete it without a further
  permission, and you see it in the device list with its creator.
- **Passed on for a task** appears for a team member while its lead passes a device
  on with a task that is open now. It is for your information: you change nothing
  there, and the entry leaves when the task has ended or was asked to stop. The
  open tab and the device list follow that at once, as they follow an agent that is
  archived or restored or that gains or loses its Telegram bot for other people.
- The text below says in short which runs use a device (see [Which runs](#which-runs)),
  and **Manage Android devices** opens **Settings › General › Android devices**.

The choice is part of the Access tab's draft: **Save agent** in the bar at the bottom
stores it together with the tab's other changes, and it applies at once, without a
restart of the agent. A change made elsewhere shows in the open tab; if you were
editing the devices meanwhile, your choice stays and the bar offers **Reload** or
**Overwrite anyway**. An agent that cannot be given devices (see
[Which agents](#which-agents)) reads why in place of the choice. A temporary team
member has the same group as the one thing you set on its Access tab, with its own
**Save devices**.

The tool is offered to your agents while the components are installed and the host
can run devices; an agent without a device has the tool and an empty list. An
assignment needs no restart of the agent.

### Which agents

Only your own agents get devices. An **agent of restricted users** (its own or a
shared one), an **archived agent** and an **agent with its own Telegram bot for other
people** cannot be given a device (`DEVICE_AGENT_INELIGIBLE`), and a device you
assigned earlier counts for nothing while one of these holds; your assignment is kept
and counts again when it no longer does.

### Which runs

Whether a call is served depends on the run it belongs to, as AgentPier recorded it,
never on what the agent says:

| Run                                                                                                                                                                                                                                               | Use a device                         | Create, reset, delete     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| A turn you started with your own message, in the web chat or your paired Telegram chat                                                                                                                                                            | yes                                  | yes, with your permission |
| A goal continuation, a reminder, and what your own agents and coding sessions report into your chat: a member's or a team's result, a coding run's result, a coding session's question, notice or change, the note that a member's chat grew long | yes                                  | no                        |
| A routine's run                                                                                                                                                                                                                                   | yes                                  | no                        |
| A hook's run, while its event runs                                                                                                                                                                                                                | yes                                  | no                        |
| A run of your chat without a turn (the follow-up after a background command, a check-in), while the chat's latest turn was one that could use a device                                                                                            | yes                                  | no                        |
| A member's turn on a task of its lead                                                                                                                                                                                                             | what the lead passed on, and its own | no                        |
| A turn on a forwarded message, on what a restricted user, a team member or a remote host (SSH, SFTP) sent, and a memory step                                                                                                                      | no                                   | no                        |
| The outcome of something that waited for you (a mail the agent sent, its SSH access proposal, a project-knowledge note that was not saved, a coding request you approved)                                                                         | no                                   | no                        |
| A run whose origin AgentPier does not know, and every kind of turn that is not named above                                                                                                                                                        | no                                   | no                        |

An agent that tries to create, reset or delete elsewhere is told to ask you
(`DEVICE_OWNER_TURN_REQUIRED`); a run that gets no device is told so
(`DEVICE_RUN_FORBIDDEN`). A call that waits behind another call on the same device,
and a `create` that waits behind another create or a start, is
checked again when its turn comes, so nothing runs for a turn that has ended
meanwhile. A call the agent's runtime gave up (its turn was stopped, or it waited
too long) is ended as well: what it runs on the device is aborted, and a call that
still waits behind another never runs.

A call counts for the run it names, not for whatever turn its chat has by then. On
OpenClaw every call names its run: a late call of an earlier turn gets no device
(`DEVICE_RUN_FORBIDDEN`) even when a turn of yours runs in the chat meanwhile, and a
call of a run AgentPier sent no turn for (the follow-up after a background command, a
check-in) uses devices like a run without a turn and never creates, resets or deletes
on your turn's account. Hermes names no run with a call, so there a call counts for
the turn its chat has when it arrives.

What this cannot know: "forwarded" is a fact of a Telegram message. Text you paste
into a chat yourself, a web page the agent reads, an email it fetches or a file it
opens in a turn of yours is part of your turn. What a device shows is untrusted in
the same way (see [What a device shows is untrusted](#what-a-device-shows-is-untrusted)).

### Team members

A lead can pass a device on to a member with a task: `agentpier_team_delegate` takes
`access.devices`, a list of ids or names.

- A lead passes on only what it has itself (a device you assigned to it, or one it
  created), and only from a run in which it may use devices; a lead that works on
  someone else's content passes nothing on (`DEVICE_PASS_INVALID`,
  `DEVICE_RUN_FORBIDDEN`).
- The member, permanent or temporary, uses the device while it works on that task.
  The pass ends with the task, also as soon as the task is asked to stop (by the
  lead, by you or at its deadline) while the member's turn still runs, and counts
  only while the lead still has the device.
- A member never resets or deletes a passed device and creates none in a task: a
  member's task is not a turn you started.
- A member you assigned a device to yourself uses it in its own runs like any agent,
  and in a task of its lead beside what the lead passed on. That includes a turn you
  start yourself in a permanent member's own chat: there it creates devices (with
  **Create devices** on), and resets and deletes its own devices and those you
  allowed it to, exactly as an agent that is no member does. A temporary member has
  no such turn; it works on its lead's tasks only. A task the lead started
  while it worked on someone else's content gets no device at all, not even the
  member's own.
- What a lead sets up on a member reaches a device only while the lead could be
  given devices itself: a task and a routine the lead set up on a permanent member
  alike. While the lead has its own Telegram bot for other people, is archived or is
  gone, such a run gets no device (`DEVICE_RUN_FORBIDDEN`), not even the member's own.
- The device list names the member beside the device while the pass counts, and the
  audit log records the pass (`lead-share` with the number of devices).
- A temporary member's first assignment (from `agentpier_team_propose`) and a
  colleague's request (`agentpier_team_peer_delegate`) carry no device; the lead
  delegates a task with `access.devices` instead.

### Files stay in the agent's workspace

`install`, `push` and `pull` name a path on the host that must lie inside the agent's
own workspace (`<data dir>/assistants/workspaces/<agent id>`), with the rule described
under [Files stay in the session's working folder](#files-stay-in-the-sessions-working-folder):
the real path is resolved, links out of the workspace and files with a second name
are refused, and adb only ever sees a private copy. For an agent:

- **The workspace is one folder, recorded.** AgentPier records the folder (its real
  path, device and inode numbers) when you save the agent's devices, and otherwise
  the first time a file travels. Only the workspace folder itself is recorded: a
  folder at exactly its place below AgentPier's workspaces folder. A link standing
  there, to AgentPier's data folder or to any other folder, is never taken for the
  workspace, by your save or by a transfer (`DEVICE_PATH_OUTSIDE`).
- **The record is checked at every transfer.** A workspace that was moved, replaced
  or restored from a backup since is another folder and is refused
  (`DEVICE_PATH_OUTSIDE`; the agent is told that you have to save its devices). No
  call of the agent records it. **To repair it, change the agent's Android devices
  and save**: for example switch **Create devices** and save, then switch it back and
  save. A save of changed devices records the folder that is at the workspace's place
  then, when it passes the check above; while the recorded folder is still the
  workspace, a save leaves the record as it is. (Saving the Access tab without a
  change to the devices sends nothing for them; over the API,
  `PUT /api/assistants/<id>/devices` with the current value does the same.)
- **The agent's secrets never travel**: nothing in or below `.agentpier/` of the
  workspace is read or written.
- **A file is written into the workspace (`pull`) only for a run that may change
  files there** (`DEVICE_PULL_READONLY` otherwise): not for a hook's run, a routine
  with **May write** off, or a member's task that runs read-only. The agent can read
  the content with action `shell` instead.
- Project folders are not part of it: a file from a project is copied into the
  workspace first.

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
- **A device gives a network-blocked session the network.** A session whose nono
  profile blocks the network (`network.block`) reaches none on the host, but a device
  assigned to it does, and `device_shell` runs commands there. From inside a device
  such a session reaches the internet, every service on the host's loopback, and
  AgentPier's own adb server (`10.0.2.2:47600` from inside the device), which asks
  for no credentials; through it the session lists every running device and runs
  commands on each, around your assignments and while you hold a device. Checked with
  two emulators on macOS: a session with one device sent adb's `host:devices` and
  `host:transport:<the other device>` with the device's `nc` and ran a shell command
  on the device it was not given. **Do not assign a device to a session whose sandbox
  is meant to keep it off the network, and do not let such a session create one.**
- **Loopback adb is not an access boundary.** AgentPier runs its own adb server on
  `127.0.0.1:47600` and each running device listens on two loopback ports from
  `47602` to `47621`. The adb server asks for no credentials: any local process
  that can open a TCP connection to loopback, of any account on the host, lists the
  devices and runs commands on every running one through it (checked with a plain
  socket and no adb key). Assignments decide which tools AgentPier offers to an agent
  or session; they do not isolate a device from other local processes, and AgentPier
  adds no firewall.
  - A device's **console port** (the even one) asks for a token that the emulator
    keeps in `<data dir>/devices/home`; without it a command such as `kill` is
    refused (checked). Its **adb port** (the odd one) is the device's own adb
    endpoint, which authenticates a client by its adb key; AgentPier's key is in the
    same folder (not tried with another key). A process that cannot read the data
    folder has neither, but the adb server in front of them asks for none.
  - **Sessions without a sandbox** run as the AgentPier account and reach all of
    this, whatever you assigned.
  - **[Sandboxed sessions](sandbox.md)** depend on their nono profile. nono allows
    the network by default, loopback included, so such a session can talk to the adb
    server directly, around the assignments; it cannot read the adb key or the
    console token, which lie in a folder it is not granted. A profile that blocks
    the network (`network.block`) blocks loopback as well, and AgentPier opens no
    device port for a session; such a session reaches the adb server only from
    inside a device it was given (see "A device gives a network-blocked session the
    network" above), which is enough to reach every other running device. (Read from nono's documented behaviour and AgentPier's launch code; not
    tried with a device under nono.)
  - **The device tools work in every sandboxed session** all the same: they go to
    the AgentPier server over the session's granted Unix socket, and the server
    talks to adb.
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

## What runs on the host

Measured with the pinned emulator 37.3.10 and platform-tools 37.0.3 on macOS (Apple
silicon) and Ubuntu 24.04 with KVM.

- **Processes.** One adb server for all devices
  (`adb -L tcp:localhost:47600 server nodaemon`, a child of AgentPier), and per running
  device the emulator (`qemu-system-…-headless`) with two helpers it starts itself:
  `netsimd` (Bluetooth and Wi-Fi simulation) and `crashpad_handler`. The emulator and
  its helpers are one process group and end together.
- **The emulator calls adb itself.** If AgentPier's adb server is gone while a device
  runs, that call starts a detached adb server on the same port, which on Linux
  ignores `SIGTERM`. AgentPier ends such a server of its own installation with
  `adb kill-server` before it starts its own, and a restarted server lists a running
  device again within about three seconds. `adb connect` is never used: it would add
  a second connection to the same device.
- **Listeners**, all on `127.0.0.1` or `::1`: the adb server on 47600; per device its
  console and adb port (47602 to 47621) and three ports the system assigns; `netsimd`
  on two assigned ports and the fixed port 6402. The emulator and `netsimd` also hold
  UDP sockets without a bound address for the device's outgoing traffic; they offer
  no service. adb's own mDNS discovery, which would open UDP port 5353 on every
  interface, is turned off.
- **Crash reports.** `crashpad_handler` is started with an upload address of Google's
  although the emulator runs with `-no-metrics`. Whether it would upload a crash was
  not tested; its database stayed empty in every run.
- **A warning in the device's log is expected:** "Requested adb port (47603) is outside
  the recommended range [5555,5586]". The ports are outside that range on purpose,
  so that an adb server of yours does not find AgentPier's devices.
- **The system image** is Google's `google_apis` image for Android 16, a `userdebug`
  build, with Chrome 133. Chrome's first-run screens are turned off at a device's
  first start and again after a reset.
- **A device on disk** is 3.7 to 4.3 GB after its first start and stop; 2.6 GB of that
  is the saved memory of its last state.
- **After a hard end** (a crash, a kill, a reboot of the host) a device's lock files
  stay in its folder and do not keep it from starting. Its next start is a cold boot.

## Files

Everything lives below `<data dir>/devices`, readable by the AgentPier account only:
`sdk` (the components), `avd` (the devices), `home` (adb keys and emulator state),
`downloads`, `run` (with `run/transfers`, the private copies of files on their way
to or from a device, removed after each call), `logs` (the emulator output of each
device's last start), `settings.json`, `devices.json`, `session-grants.json`
(which devices are assigned to which session) and `agent-grants.json` (which devices
are assigned to which agent, and the workspace folder recorded for it). **System status › Storage** lists it as **Android
devices**.

If `devices.json` cannot be read at a start (cut off by a crash, edited by hand),
AgentPier keeps it as `devices.json.damaged-<time>`, says so in the server log, and
lists every device whose folder exists under `avd` again as **Recovered device 1**,
**2** and so on, created by you. Their contents are untouched; names, creators and
assignments are lost, so rename the devices or delete the ones you do not need. The
kept file is yours to inspect and delete.

The same holds for `session-grants.json` and `agent-grants.json`: a file that cannot
be read, or that holds an entry AgentPier cannot read, assigns nothing there, is kept
as `session-grants.json.damaged-<time>` or `agent-grants.json.damaged-<time>` and
named in the server log; the file itself is then written anew from the entries that
could be read. Assign the devices again; the kept file shows what was assigned.

Two things the emulator writes elsewhere and AgentPier cannot redirect: its crash
database under `/tmp/android-<account>/`, and on Linux `netsimd` logs in the same folder.
On Linux `netsimd` also keeps its small `netsim.ini` files in the account's runtime
folder (`/run/user/<uid>`); on macOS they are in `<data dir>/devices/run/tmp`.

**Devices are not part of backups.** Neither the components nor any device is in a
backup or restored from one ([backups](backups.md)): the components are a download, and
a device is several gigabytes of emulator state. After a restore on a new host, install
the components and create the devices again.

## Troubleshooting

The page shows each of these in words; the codes appear in the audit log, the server
log and the installer's result.

| Code                                                                            | Meaning and what to do                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICES_PLATFORM_UNSUPPORTED`                                                  | No emulator build for this host. Use macOS on Apple silicon or Linux x64.                                                                                                                                                                                     |
| `DEVICES_KVM_MISSING`                                                           | Linux has no `/dev/kvm`. Turn on hardware virtualization in the firmware, or nested virtualization for a virtual machine.                                                                                                                                     |
| `DEVICES_KVM_DENIED`                                                            | AgentPier may not open `/dev/kvm`. Add its account to the `kvm` group (`sudo usermod -aG kvm <name>`), sign that account in again and restart AgentPier.                                                                                                      |
| `DEVICES_SDK_UNUSABLE`                                                          | The downloaded emulator does not start. On Linux install `libx11-6` and `libx11-xcb1`; the page names the missing libraries when the system reports them. Then **Try again …**.                                                                               |
| `DEVICES_DOWNLOAD_FAILED`, `DEVICES_DOWNLOAD_STALLED`                           | The download broke off or stopped making progress. Check the connection to `dl.google.com` and **Try again …**; it continues.                                                                                                                                 |
| `DEVICES_CHECKSUM_MISMATCH`, `DEVICES_ARCHIVE_INVALID`                          | A downloaded archive was not the pinned one or could not be unpacked. It was discarded; **Try again …**.                                                                                                                                                      |
| `DEVICES_DISK_SPACE`, `DEVICE_DISK_SPACE`                                       | Too little free space for the components or for another device. Free up space or delete a device.                                                                                                                                                             |
| `DEVICES_INTERRUPTED`                                                           | AgentPier stopped during the installation. **Try again …** continues the download.                                                                                                                                                                            |
| `DEVICES_INSTALL_FAILED`                                                        | The installation or removal failed for another reason. Try again; check the free space and the server log.                                                                                                                                                    |
| `DEVICES_IN_USE`, `DEVICES_OPERATION_RUNNING`                                   | A device runs, or the components are being installed, updated or removed. Stop the devices, or wait.                                                                                                                                                          |
| `DEVICE_LIMIT_TOTAL`, `DEVICE_LIMIT_RUNNING`                                    | A limit is reached. Delete or stop a device, or raise the limit.                                                                                                                                                                                              |
| `DEVICE_BOOT_TIMEOUT`                                                           | The device did not finish booting within 3 minutes. Start it again; if it keeps failing, reset it.                                                                                                                                                            |
| `DEVICE_EXITED`                                                                 | The emulator ended by itself, during the boot or while running. Start the device again; `<data dir>/devices/logs/<id>.log` holds its last output.                                                                                                             |
| `DEVICE_PORTS_BUSY`                                                             | Another program uses AgentPier's loopback ports 47600 to 47621. Close it and start the device again. The ports are fixed.                                                                                                                                     |
| `DEVICE_IMAGE_MISSING`                                                          | The system image a new or reset device needs is not installed, usually because an update of the components has not run yet. Update the installation, then try again. A device on an earlier image still starts until it is reset.                             |
| `DEVICE_ADB_FAILED`, `DEVICE_ADB_TIMEOUT`                                       | AgentPier could not reach the device through adb. Stop the device and start it again. When the page says that port 47600 is used by another program, see "A second AgentPier on the same machine" below.                                                      |
| `DEVICE_FORBIDDEN`, `DEVICE_CREATE_FORBIDDEN`                                   | A session used a device it was not given, tried to reset or delete without that permission, or to create a device without it. Assign the device or allow the action for the session.                                                                          |
| `DEVICE_HELD`                                                                   | You are holding the device, so a session's call on it was refused. It can go on when you hand the device back.                                                                                                                                                |
| `DEVICE_PATH_OUTSIDE`, `DEVICE_FILE_NOT_FOUND`, `DEVICE_FILE_TOO_LARGE`         | A file for a device was outside the session's working folder, missing, or larger than 200 MB (to a device) or 50 MB (from it). `DEVICE_PATH_OUTSIDE` also when the working folder itself was moved or replaced since the session started: reload the session. |
| `DEVICE_TEXT_UNSUPPORTED`, `DEVICE_ELEMENT_STALE`, `DEVICE_INPUT_INVALID`       | A session typed text beyond ASCII, used an element number of an outdated overview, or passed a malformed argument. The session is told what to do instead.                                                                                                    |
| `DEVICE_COMMAND_FAILED`, `DEVICE_SCREEN_UNAVAILABLE`, `DEVICE_CALL_TIMEOUT`     | The device refused an action (the session gets its words), did not deliver its screen, or a call took longer than 140 seconds.                                                                                                                                |
| `DEVICE_ASSIGNMENT_INVALID`, `DEVICE_SESSION_INELIGIBLE`                        | An assignment named a device that no longer exists, or a session that cannot be given devices (see [Devices for coding sessions](#devices-for-coding-sessions)).                                                                                              |
| `DEVICE_AGENT_INELIGIBLE`, `DEVICE_RUN_FORBIDDEN`, `DEVICE_OWNER_TURN_REQUIRED` | An agent that cannot be given devices, a run that gets none, or a create, reset or delete outside a turn you started (see [Devices for agents](#devices-for-agents)).                                                                                         |
| `DEVICE_PULL_READONLY`, `DEVICE_PASS_INVALID`                                   | An agent's run may not change files in its workspace, so nothing was copied from the device; or a lead tried to pass on a device it does not have.                                                                                                            |
| `DEVICE_STOP_FAILED`                                                            | The device did not stop. The row keeps **Stop**: use it again (reset and delete try the stop again too); restarting AgentPier ends what is left of it.                                                                                                        |

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
