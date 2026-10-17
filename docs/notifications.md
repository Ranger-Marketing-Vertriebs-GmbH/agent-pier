# App and notifications

AgentPier can run as an installed web app (PWA) and send push notifications to the
devices you enable. Both are set up per device under
**Settings → Workspace → App & notifications**.

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

1. Open **Settings → Workspace → App & notifications** on the device itself.
2. Switch on **Notifications** under **Notifications on this device** and allow them
   when the browser asks.
3. Optionally set a **Device name** and choose **Save name**.
4. Choose **Send test notification** to check the delivery.

If the status says **Not fully enabled**, turn **Notifications** off and on again.

## Registered devices

**Registered devices** lists every device that receives notifications, with its name,
when it was registered and when a notification last reached it. The device you are
using is marked **This device**. A device whose last delivery failed shows **Last
delivery error**. **Unregister** stops notifications for a device; it can be enabled
again on that device.

## What notifies you

| Notification                 | When                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Approval required            | A session waits for your decision                                                                                               |
| Question                     | A session waits for your answer                                                                                                 |
| Response ready               | A session finished its reply                                                                                                    |
| Session ended                | A session stopped                                                                                                               |
| Pipeline waiting             | A pipeline waits at a human gate                                                                                                |
| Pipeline ended               | A pipeline run finished                                                                                                         |
| Agent check-in               | An agent [checked in](agents.md#routines-reminders-and-check-ins) with something for you                                        |
| Telegram access still active | A Telegram bot or person you removed could not be stopped; restart the agent service                                            |
| Check GitHub token           | The [daily token check](github-agents.md#token-check) found a saved GitHub token invalid, expired or expiring within seven days |

Notifications carry only the event type. Tasks, commands and chat content stay on the
host. Opening a notification opens the matching view; it never approves anything.

## Apple devices after updating to 2.0

Earlier versions sent push messages with a sender address that Apple's push service
rejects, so notifications to iPhone, iPad and Safari on macOS could fail. 2.0 fixes
this. If such a device still receives nothing, send a test notification from it; if
the test fails, turn **Notifications** off and on again on that device.
