# Navigation and information architecture

---

Status: agreed; implemented.

Date: 2026-10-25

---

## Context

Managing agents was spread over six places: Menu › Agents, three settings tabs
(Workspace › Agents, Agent service and its Advanced page), Accounts, Extensions and
Projects. A fully set up agent needed about eleven pages. One word, "Agent", meant
personal agents, Agency templates and CLI subagents. Credentials were created in one
place and granted in another; the agent's tabs grouped them by technology (MCP servers
under Capabilities, SSH, GitHub and secrets under Work); runtime settings sat three
levels deep; and creating an agent covered only its profile and capabilities.

The sidebar is the place the owner returns to all day: agents and sessions. Everything
else is set up once and visited rarely.

## Decision

Organise by object, not by technology. The owner decided:

1. **The menu stays a popover** on the **Menu** button in the sidebar head. It never
   becomes a permanent list of areas in the sidebar.
2. **The sidebar order stays:** head (collapse, search, Menu), brand, **New**, **Inbox**,
   the **Agents** group, the **Sessions** group, host status. On phones the drawer keeps
   its look and order (brand + Menu, New, Agents, Sessions); the Inbox sits in the
   mobile header. The two group heads gain two icon buttons each (agents page and new
   agent; CLIs and extensions and new session).
3. **Menu content in two groups with status hints:** **Work** (Overview, Projects,
   Pipelines, Files, Artifacts) and **Set up** (Agents, CLIs and extensions,
   Connections, Settings). Hints come only from data the app already has or reads once
   when the menu opens; a failing source shows no hint, never a zero. No new polling.
4. **Access from long lists is added inline:** every group of an agent's **Access** tab
   ends in an add field (`AddPicker`) with filtering, multi-select and a mode. Rule-based
   grants ("all accesses of project X") and a single grant sheet across types were
   considered and left out.
5. **Approved behaviour changes:**
   - **Agents** stays in the menu while agents are off and leads to a page that offers
     **Enable agents** (before, the entry disappeared).
   - The new agent wizard creates the agent, its grants, channel and an optional
     routine in one flow through the existing endpoints; when a later step fails, the
     agent stays and the failed steps are listed with a retry each.
   - The advanced agent service values are shown inline on **Agents › Runtime**
     instead of on their own page; the old address keeps working.
   - The settings tab **Access** disappears; its pages move to **Connections**, **CLIs
     and extensions › AgentPier as MCP** and the **Settings** tabs **Users** and
     **Remote access**.
   - The CLI extensions tab **Agents** is renamed **Subagents** (German
     **Unteragenten**).
   - New: duplicating an agent, a teams overview across all agents, a **Storage** row
     in Settings › Operations and Agents › Runtime, and ⌘K search.

The resulting areas:

| Area                | Address                      | Holds                                                                                                                 |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Agents              | `/agents?tab=…`              | All agents, Teams, Templates (Agency catalog), Runtime (agent service, updates, advanced, dreaming, storage)          |
| Agent settings      | `/agents/:id/settings?tab=…` | Overview, Identity, Capabilities, Access, Team, Automation, Channels                                                  |
| CLIs and extensions | `/coding/clis?tab=…`         | Installation, native CLI Accounts, Extensions (skills, plugins, marketplaces, subagents), AgentPier as MCP            |
| Connections         | `/connections?section=…`     | Model access, Services for agents, MCP servers, SSH/SFTP accesses, Secrets, GitHub connections, each with **Used by** |
| Settings            | `/settings?tab=…`            | General, App and notifications, Users, Remote access, Operations                                                      |

Shared credentials are created once under Connections and granted where they are used;
both sides link to each other and change the same setting through the same endpoints,
with the same revisions, confirmations and audit events. No permission rule changed.

Every old address redirects in the client with its parameters and `returnTo`
(`web/app/route-redirects.js`), so links in notifications, Telegram, audit entries,
bookmarks and docs keep working; the server still builds `/settings/mcp?authorization=…`
and `/accounts?oauth=…`.

Two read-only endpoints back the new views: `GET /api/connections/usage` ("Used by" for
SSH/SFTP accesses, secrets and GitHub token profiles) and `GET /api/connections/problems`
(problem counts per category). The last SSH connection test is stored per access,
sanitized, so problems survive a restart.

## Consequences

- The sidebar stays short however many areas exist; a new area is a menu entry, a
  search entry and a route, never a sidebar row.
- One agent's whole access is in one tab, and every credential shows who uses it, so
  revoking or deleting names what it affects.
- The search index must know every page, tab and old name in both languages; a new page
  or tab without a search entry is a gap.
- Old addresses are a contract: removing a redirect breaks stored links. The **Moved**
  group in Settings › General is shown for two releases (removal planned for 2.9.0).
- "Last used" covers agents' SSH commands and SFTP transfers and sessions' SFTP
  transfers only; commands from coding sessions through the SSH helper are not
  counted, and the list says so instead of claiming completeness.

User guides: [Agents](../agents.md), [SSH accesses](../ssh-access.md),
[shared CLI extensions](../shared-cli-extensions.md); UI rules:
[UI guide › Sidebar, menu and search](../ui-guide.md#sidebar-menu-and-search) and the
[settings pattern](../settings-pattern.md#routes).
