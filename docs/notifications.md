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
delivery failed** with the time and the push service's reason; the next successful
delivery clears it. The server keeps the last 20 delivery attempts per device (time,
result, the push service's status code and reason) for at most 30 days. **Settings** opens what that device receives (see below), also for a
device other than the one you are using. **Unregister** stops notifications for a
device; it can be enabled again on that device.

Restricted users register their own devices in their own app. Each device belongs to
one person: a user's device gets notices only about their own agents and chats (their
reminders, routines, check-ins and approvals), never the owner's or system notices,
and the owner's device list never shows theirs. Their device's **Settings** offer only
those events (**Agent approval** and **Reminder you asked an agent for**, on by
default; **Agent check-in**, **Routine or hook result** and **Also what Telegram
delivered**, off by default). Quiet hours and "quiet while visible" count per person.

## Keeping devices registered

A browser can lose its registration without anyone turning notifications off: the
browser's push service renews or drops the subscription, or answers that it no longer
exists (HTTP 404 or 410), and AgentPier then removes the device. To keep this from
going unnoticed:

- **Registering again on its own.** Whenever AgentPier opens, and after signing in, a
  browser that has the notification permission and still holds its push subscription
  registers again if the server no longer knows it, under the derived device name; a
  device the server still knows sends its current subscription, keeping its name and
  settings. Only the person who turned notifications on in that browser gets it back
  this way; another person's subscription is never taken over. When the browser
  replaces a subscription on its own (`pushsubscriptionchange`), the service worker
  subscribes again and tells the server, signed in with the page's session.
- **Removals are recorded.** A device removed because its subscription expired, because
  its browser signed out, because someone else signed in there, or because the owner
  ended a user's sign-in, appears in the audit log as `notification.unsubscribed` with
  the reason (and the status code for an expired one), and in the server log. Neither
  ever contains the device's endpoint or keys.
- **A warning when nothing arrives.** The start page and the [inbox](inbox.md) show
  **Notifications reach no device** when no device of yours is registered (unless you
  unregistered the last one yourself), naming the last device AgentPier removed and
  why, and **Notifications are not arriving** when the last delivery to every one of
  your devices failed. A restricted user sees the same warning on their start page.
  **Notification settings** opens the page to turn them on again; **Hide** hides the
  warning until the browser session ends. Pages served over plain HTTP, where
  notifications cannot be enabled, do not show it.

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

| Level               | Shows                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Event type only** | What happened, for example "Question: A session is waiting for your answer". Meant for shared devices. Devices registered earlier keep their level.                                                                                              |
| **With names**      | Also the session, agent or pipeline name, the CLI, the pipeline stage, the project folder's name and the tool a CLI approval asks for, for example "api-refactor · Approval required" and "A session wants to use Bash." New devices start here. |
| **With preview**    | Also up to 140 characters of a question, the start of a reply, an agent check-in or a team proposal's goal.                                                                                                                                      |

A new device starts at **With names**; choose **Event type only** in its **Settings**
for a device others can see. An agent approval names what waits (for example **SSH
command**, **SFTP transfer** or **Email to send**); a CLI approval names its tool (for
example `Bash`, `Edit` or Codex's `shell`), never the command, its arguments or a
path.

Notifications never contain commands, arguments, file paths, working directories,
URLs, tokens or other secrets, at any level. Approvals (of a CLI or an agent, including
shell and SSH commands) never show a preview. Code in a preview is left out, and a
preview or name that looks like a command, a path, a URL or a secret is not shown at
all. The server sends only data (kind, names, preview, link, grouping tag, inbox
count) of at most 1 KB; the app words it in your interface language.

### Allow once and Deny

Where the platform shows notification buttons (Chrome and Edge on desktop and Android),
an approval offers **Allow once** and **Deny** at every detail level:

- A CLI approval offers both when the CLI has a once-only choice, and only **Deny**
  otherwise (a Codex permission request grants for the whole turn). Plans, folder trust
  and startup prompts offer no buttons.
- An agent's coding task or coding session start, memory entry and team member
  permission offer both. A shell, SSH or SFTP command and an email to send offer only
  **Deny**, because the notification never shows what would run or be sent. Hook and
  SSH access proposals, team proposals and a user's own approvals offer no buttons.
- Nothing is ever allowed permanently, for a session or for a turn from a notification:
  **Always allow** and similar choices exist only in AgentPier.

The button sends the decision with the browser's signed-in session. The notification
names the exact inbox item and its revision, and the server decides only while that
item still waits unchanged; otherwise, or when the device is offline or signed out, the
inbox item opens instead, which shows why. A decision that succeeds opens nothing.
Decisions on agent approvals appear in the audit log with the channel `push`. iPhone
and iPad show no buttons: tapping opens the place where the approval waits (see below).

### Opening a notification

Opening a notification opens the exact place it is about, where a waiting item shows
its own card to answer:

| Notification                                                                    | Opens                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Question or approval from a CLI, session waiting, response ready, session ended | The session's chat (`/sessions/<id>/chat`)                                                 |
| Session reached its usage limit, session could not be resumed                   | The session's chat                                                                         |
| Pipeline waiting at a gate, pipeline completed or failed                        | The pipeline run (`/pipelines/runs/<id>`)                                                  |
| Agent approval and team proposal                                                | The agent chat it was asked in, or the agent's main chat when that chat is gone            |
| Agent check-in, reminder, routine or hook result, hook limit reached            | The agent chat it was written to (`/agents/<agent>/chats/<chat>`)                          |
| Update available, update failed                                                 | **Settings › Operations › Updates**                                                        |
| Telegram access still active                                                    | The agent's settings, or **Agents** when no agent is named                                 |
| Check GitHub token, disk space is low, test notification                        | **Connections › GitHub connections**, the start page, **Settings › App and notifications** |

An item that has no such place (an agent approval of an agent without any chat of
yours) opens its [inbox](inbox.md) address (`/inbox/<type>/<id>`), which shows **Already
done** once it was answered elsewhere. A restricted user's approvals open the chat in
their own app.

When AgentPier is already open, the open window comes to the front and shows the page
in place, without reloading, so unsaved changes still ask first; this also works in
the installed app on iPhone and iPad, where a notification cannot reliably navigate an
open window. A
window of an older AgentPier version that does not answer is navigated instead. Only
without any open window does a new one open.

## What notifies you

**Settings** next to a device opens its notification settings; **Save** applies them.

**Events** chooses which events notify this device. By default a device is notified
about what needs you and about problems; everything that only informs you is off
until you switch it on:

| Group           | Event                                              | Default | When                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs you       | Question from a CLI                                | On      | A session waits for your answer                                                                                                                                                                                                                                                                                                                                                            |
|                 | Approval for a CLI                                 | On      | A session waits for your decision                                                                                                                                                                                                                                                                                                                                                          |
|                 | Session waiting in the terminal                    | On      | A session's CLI reports that it waits for you in the terminal, outside AgentPier's approvals and questions, for a few seconds                                                                                                                                                                                                                                                              |
|                 | Pipeline waiting at a gate                         | On      | A pipeline waits at a human gate                                                                                                                                                                                                                                                                                                                                                           |
|                 | Agent approval (shell, SSH, tasks, team proposals) | On      | An agent waits for approval of a shell or SSH command, an SFTP transfer, an email to send, a coding task or coding session start, a memory entry, a team member's permission, a hook or an SSH access proposal, or proposes a team                                                                                                                                                         |
|                 | Reminder you asked an agent for                    | On      | A [reminder](agents.md#routines-reminders-and-check-ins) you asked an agent for is due (or failed); opens the agent's chat. Follows **Routine or hook result** on a device set up before it existed                                                                                                                                                                                        |
| Problems        | Pipeline failed                                    | On      | A pipeline run failed (a cancelled run does not notify)                                                                                                                                                                                                                                                                                                                                    |
|                 | Session reached its usage limit                    | On      | A session's CLI ended a turn at its rate limit or usage quota (Claude Code's `StopFailure` with `rate_limit` or `billing_error`, a Codex turn failed with `usageLimitExceeded`); once per occurrence until a turn succeeds again; opens the session's chat. **With preview** shows the CLI's own limit message, which names the reset time                                                 |
|                 | Session could not be resumed                       | On      | [Resuming interrupted sessions](session-reload.md) failed for a session after AgentPier's terminal server was lost; once per interruption; opens the session's chat                                                                                                                                                                                                                        |
|                 | Hook limit reached                                 | On      | An [agent hook](assistant-workflows.md#agent-hooks) received more events in an hour than it may wake its agent for; later events are only recorded and wait unprocessed, so raise the limit or fix the sender; opens the agent's chat. Follows **Routine or hook result** on a device set up before it existed                                                                             |
|                 | Update failed                                      | On      | Downloading and checking, activating or rolling back a version failed (also when the activation helper failed while AgentPier restarted); once per attempt, within a day; opens the updates                                                                                                                                                                                                |
| For information | Response ready                                     | Off     | A session finished its reply to a prompt you sent, in the terminal or in AgentPier's chat. For Claude Code, a turn Claude started itself (a background task's or subagent's notification, a peer or channel message) does not notify; Codex and OpenCode do not report who started a turn, so every finished turn notifies                                                                 |
|                 | Session ended                                      | Off     | A session stopped                                                                                                                                                                                                                                                                                                                                                                          |
|                 | Pipeline completed                                 | Off     | A pipeline run completed                                                                                                                                                                                                                                                                                                                                                                   |
|                 | Agent check-in                                     | Off     | An agent [checked in](agents.md#routines-reminders-and-check-ins) with something for you; opens its chat                                                                                                                                                                                                                                                                                   |
|                 | Routine or hook result                             | Off     | A [routine](agents.md#routines-reminders-and-check-ins) or an [agent hook](assistant-workflows.md#agent-hooks) wrote in an agent's chat; opens that chat                                                                                                                                                                                                                                   |
|                 | Update available                                   | Off     | The daily update check (a few minutes after AgentPier starts, then once a day) found a newer version on your channel; once per version, never for a version **Check for updates** under **Settings › Operations › Updates** already showed; opens the updates. Without it, the menu's **Settings** hint, the start page and **Settings › Operations › Updates** still show the new version |
|                 | Also what Telegram delivered                       | Off     | Check-ins, reminders, routine and hook results that also went to the agent's paired Telegram chat; while off, Telegram alone tells you about them                                                                                                                                                                                                                                          |

**Session reached its usage limit**, **Session could not be resumed**, **Update
available** and **Update failed** go to the owner's devices only, never to a
restricted user's or to Telegram. AgentPier has no reliable signal for a session that is stuck, so it does not
guess one; only the CLI's own limit report notifies. AgentPier checks for updates on its own a few minutes after it starts and then once a day ([updates](operations.md#installer-and-exact-commands)); only this automatic check notifies, a check someone starts with **Check for updates** never does, and a failed check notifies nobody.

**After updating from 2.14 or earlier:** devices registered before the update are
moved to these defaults once. AgentPier cannot tell a switch you set from one that
was still at its old default, so **Response ready**, **Session ended**, **Agent
check-in**, **Routine or hook result** and **Update available** are switched off on
every existing device, including one where you had switched them on yourself.
Reminders keep notifying where routine results did. Switch any of them on again under
**Settings** next to the device; that choice stays, the move never runs again, and an
older version you roll back to keeps it as well (such a version sends reminders as
routine results, so they stay quiet there until you switch those on).

A coding CLI's own activity reports (Claude Code's hooks, the Codex app-server proxy
and the OpenCode plugin) trigger these session events at once instead of at the next
check every few seconds, and a turn that starts and finishes between two checks still
counts as **Response ready**. A question or approval that AgentPier brokers notifies
as **Question from a CLI** or **Approval for a CLI** only; **Session waiting in the
terminal** is sent only for a wait that no such request covers. Every push opens the
session's chat, where a question or approval shows its card.

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

**Delivery to a device that is offline:** a notification that waits for you (a
question, an approval, a session waiting in the terminal or a pipeline gate) is sent
with high urgency and kept by the push service for up to 24 hours, so a phone that was
off or out of reach still gets it; opening it after it was answered shows **Already
done** in the inbox. Every other notification is kept for five minutes at normal
urgency.

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
