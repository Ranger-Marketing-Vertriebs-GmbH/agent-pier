# App and notifications

AgentPier can run as an installed web app (PWA) and send push notifications to the
devices you enable. Both are set up per device under
**Settings › App and notifications** (an agent's **Channels** tab links there too).

## Requirements

- **A secure origin.** Installing the app and push notifications need HTTPS or
  `localhost`. Use [Tailscale Serve](remote-access.md#weg-a-tailscale-serve) for other
  devices. The [network mode without Tailscale](remote-access.md#weg-b-netzwerkmodus-ohne-tailscale)
  uses plain HTTP and offers neither.
- **iPhone and iPad** need iOS or iPadOS 16.4 or later, and push works only in the app
  added to the Home Screen, not in a Safari tab.
- A browser with Web Push support. When the browser blocks notifications, change the
  site permission in the browser settings and reload the page.

## Install the app

Under **App**, **AgentPier as an app** shows whether this page already runs as an
installed app. Choose **Install app**, or **Install app** / **Add to Home Screen** in
the browser menu. Offline, the app shows only a public notice; sessions, chats, API
responses and credentials are not stored for offline use. An open page that loses its
connection keeps showing what it already loaded until the connection is back.

## Enable notifications on a device

1. Open **Settings › App and notifications** on the device itself.
2. Switch on **Notifications** under **Notifications on this device** and allow them
   when the browser asks.
3. Optionally set a **Device name** and choose **Save name**.
4. Choose **Send test notification** to check the delivery.

If the status says **Not fully enabled**, turn **Notifications** off and on again.

## Registered devices

**Registered devices** lists every device that receives notifications, with its name,
when it was registered and when a notification last reached it. The device you are
using is marked **This device**. A device whose last delivery failed shows **Last
delivery error**. **Settings** opens what that device receives (see below), also for a
device other than the one you are using. **Unregister** stops notifications for a
device; it can be enabled again on that device.

Restricted users register their own devices in their own app. Each device belongs to
one person: a user's device gets notices only about her own agents and chats (her
reminders, routines, check-ins and approvals), never the owner's or system notices,
and the owner's device list never shows hers. Her device's **Settings** offer only
those events (**Agent approval**, **Agent check-in**, **Routine or hook result** and **Also what
Telegram delivered**). Quiet hours and "quiet while visible" count per person.

Signing out of a browser unregisters it for the person who signs out and closes her
notices still in the browser's notification tray and clears the app badge, so a shared
tablet never shows her notices to the next person. Signing in as someone else on a
browser that another person registered unregisters it for that person as well; the new
person turns **Notifications** on there to receive her own. Signing a user out remotely
unregisters her devices too: the owner's **Reset password** and turning **Sign-in
allowed** off remove all of them, and her own **Change password** keeps only the browser
she changed it on.

## What a notification shows

Each device has its own **Detail level**. The server applies it, so a device never
receives more than its level allows:

| Level               | Shows                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event type only** | What happened, for example "Question: A session is waiting for your answer". Meant for shared devices. New and existing devices start here.                   |
| **With names**      | Also the session, agent or pipeline name, the CLI, the pipeline stage and the project folder's name, for example "api-refactor · Question" and "Claude Code". |
| **With preview**    | Also up to 140 characters of a question, the start of a reply, an agent check-in or a team proposal's goal.                                                   |

When you enable notifications on a new device, the page offers **Show names in
notifications?**; **Show names** switches that device to **With names**, **Not now**
keeps **Event type only**.

Notifications never contain commands, arguments, file paths, working directories,
URLs, tokens or other secrets, at any level. Approvals (of a CLI or an agent, including
shell and SSH commands) never show a preview. Code in a preview is left out, and a
preview or name that looks like a command, a path, a URL or a secret is not shown at
all. The server sends only data (kind, names, preview, link, grouping tag, inbox
count) of at most 1 KB; the app words it in your interface language.

A notification has no action buttons. Opening it opens the matching view; it never
approves anything. Items that wait in the [inbox](inbox.md) open at their inbox address
(`/inbox/<type>/<id>`), which shows **Already done** once they were answered elsewhere;
everything else opens the exact session chat, agent chat or pipeline run. An agent
notice opens the chat that produced it; check-ins, routine and reminder results open
the agent's main chat.

## What notifies you

**Settings** next to a device opens its notification settings; **Save** applies them.

**Events** chooses which events notify this device:

| Group           | Event                                              | Default | When                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting for you | Question from a CLI                                | On      | A session waits for your answer                                                                                                                                                                                                                     |
|                 | Approval for a CLI                                 | On      | A session waits for your decision                                                                                                                                                                                                                   |
|                 | Session waiting in the terminal                    | On      | A session's CLI reports that it waits for you in the terminal, outside AgentPier's approvals and questions, for a few seconds                                                                                                                       |
|                 | Pipeline waiting at a gate                         | On      | A pipeline waits at a human gate                                                                                                                                                                                                                    |
|                 | Agent approval (shell, SSH, tasks, team proposals) | On      | An agent waits for approval of a shell or SSH command, a coding task or coding session start, a memory entry, a team member's permission, a hook or an SSH access proposal, or proposes a team                                                      |
| Finished        | Response ready                                     | On      | A session finished its reply                                                                                                                                                                                                                        |
|                 | Session ended                                      | On      | A session stopped                                                                                                                                                                                                                                   |
|                 | Pipeline completed                                 | Off     | A pipeline run completed                                                                                                                                                                                                                            |
|                 | Pipeline failed                                    | On      | A pipeline run failed (a cancelled run does not notify)                                                                                                                                                                                             |
| Agents          | Agent check-in                                     | On      | An agent [checked in](agents.md#routines-reminders-and-check-ins) with something for you; opens its chat                                                                                                                                            |
|                 | Routine or hook result                             | On      | A [routine or reminder](agents.md#routines-reminders-and-check-ins) or an [agent hook](assistant-workflows.md#agent-hooks) wrote in an agent's chat; opens that chat                                                                                |
|                 | Hook limit reached                                 | On      | An [agent hook](assistant-workflows.md#agent-hooks) received more events in an hour than it may wake its agent for; later events are only recorded; opens the agent's chat. Follows **Routine or hook result** on a device set up before it existed |
|                 | Also what Telegram delivered                       | Off     | Check-ins, routine and hook results that also went to the agent's paired Telegram chat; while off, Telegram alone tells you about them                                                                                                              |

A coding CLI's own activity reports (Claude Code's hooks, the Codex app-server proxy
and the OpenCode plugin) trigger these session events at once instead of at the next
check every few seconds, and a turn that starts and finishes between two checks still
counts as **Response ready**. A question or approval that AgentPier brokers notifies
as **Question from a CLI** or **Approval for a CLI** only; **Session waiting in the
terminal** is sent only for a wait that no such request covers. Every push opens the
session's chat, or the inbox item for a question or approval.

These always notify every device and cannot be switched off: **Telegram access still
active** (a Telegram bot or person you removed could not be stopped; restart the agent
service), **Check GitHub token** (the [daily token check](github-agents.md#token-check)
found a saved token invalid, expired or expiring within seven days), **Disk space is
low** (less than 10 % free on the drive with AgentPier's data, see
[system status](system-status.md#low-disk-space)) and the test notification.

For a session an agent started and controls, pushes change ([coding
sessions](assistant-workflows.md#coding-sessions)): **Question from a CLI** and **Approval
for a CLI** are held until the agent escalates the prompt or 15 minutes pass (the hold
survives a server restart and a reconnect of the session), **Session waiting in the
terminal** and **Response ready** are not sent because the agent is woken instead, and
**Session ended** still notifies. When the agent escalates a prompt, the held push is sent
at once. When the agent loses control (coding sessions switched off, the project revoked
or the agent archived), held pushes are sent and the session notifies like your own.

Telegram keeps its own messages and approval buttons for agents; these settings only
change push notifications.

**Grouping and quiet**:

- **Group by session, agent or run** (on by default): a new notification from the same
  session, agent or pipeline run replaces the older one instead of stacking. A
  replacement that waits for you (a question or an approval) alerts again; others
  replace it silently.
- **Quiet hours** (off by default, 22:00 to 07:00 when switched on): the server holds
  notifications back during these hours; they are not delivered later, and the inbox
  still lists what waits. The times count in the device's own time zone, which the
  device reports when it registers or saves its settings. A range may run past
  midnight. Questions, approvals and gates are held too, unless **Let questions and
  approvals through** is on.
- **Quiet while visible:** nothing is sent to any device while the inbox (for items
  that wait in it) or the same session, agent chat or pipeline run is open, visible
  and focused on one of your devices, or was within the last 30 seconds. A window left
  open in the background or without focus does not count. Open pages report the view
  they show while visible and focused, and only when at least one device is
  registered; the server keeps this in memory and never stores it.

## App badge

Where the platform supports app badges (an installed app in Chrome or Edge on desktop
and Android, the Home Screen app on iOS and iPadOS 16.4 or later, Safari 17 on macOS
Sonoma or later), the app icon shows how many items wait in the inbox. Every
notification carries the count, and an open page keeps it current.

## Grouping on Apple devices

Safari on iPhone, iPad and Mac ignores the notification tag and does not support
`renotify` (WebKit bug [258922](https://webkit.org/b/258922); MDN's browser
compatibility data lists `Notification.tag` and `renotify` as unsupported in Safari).
AgentPier's service worker therefore closes the older notification of the same
session, agent or run itself before it shows the new one. Where the system does not
allow that either, notifications stack as before; nothing else changes. Badging works
in the Home Screen app from iOS 16.4.

## Apple devices after updating to 2.0

Earlier versions sent push messages with a sender address that Apple's push service
rejects, so notifications to iPhone, iPad and Safari on macOS could fail. 2.0 fixes
this. If such a device still receives nothing, send a test notification from it; if
the test fails, turn **Notifications** off and on again on that device.
