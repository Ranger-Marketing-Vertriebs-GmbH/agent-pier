# Handoff: navigation and agent management redesign

Status: approved by the owner on 2026-10-25. Implement completely in **one pull
request**. This file and the `mockups/` folder next to it are working documents:
**delete the whole `docs/superpowers/specs/2026-10-25-navigation-redesign/` folder in
the last commit before opening the PR** (AGENTS.md, "Plans, specs, and progress logs").

## 0. How to use this document

1. Read `AGENTS.md`, `docs/ui-guide.md`, `docs/settings-pattern.md` and
   `docs/ui-glossary.md` first. They win over this document where they conflict, except
   for the decisions in section 2 that the owner made explicitly.
2. Open the mockups in `mockups/` as source. They are Design Component files
   (`.dc.html`) from a design canvas. They do not run on their own (they expect a
   `support.js` runtime), but the markup, copy and layout are the spec. They use literal
   hex colours and inline styles for drawing only: **implement with the existing tokens
   and components**, never copy their colours or CSS.
3. Mockup copy is German and partly outdated. **Section 3 (terminology) overrides the
   mockup copy.** Where the mockup says "Verbindungen", the product says "Zugänge".
4. Appendix A is the coverage checklist. Every row must be true when you finish.
   Nothing that exists today may become unreachable.

Mockup index (`mockups/`):

| File                     | Shows                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| `Main.dc.html`           | Current state: where agent topics live today (problem statement)       |
| `Soll.dc.html`           | Target information architecture and old → new mapping (early concept)  |
| `RSidebar.dc.html`       | Desktop sidebar + menu popover (prop `menuOpen` shows the open state)  |
| `RMenue.dc.html`         | Menu content: variants A/B/C. **A is chosen.**                         |
| `RAgenten.dc.html`       | Agents hub: tabs All agents, Teams, Templates, Runtime (interactive)   |
| `RNeu.dc.html`           | New agent wizard, 6 steps (interactive)                                |
| `RAgent.dc.html`         | Agent settings, 7 tabs (interactive; tweak `kind` shows variants)      |
| `RGewaehren.dc.html`     | Adding access from long lists: variants A/B/C. **A is chosen.**        |
| `RVerbindungen.dc.html`  | Connections area with long lists (SSH, MCP), bulk actions, detail pane |
| `RVollansicht.dc.html`   | Connection full view (SSH access) with "Used by"                       |
| `RCoding.dc.html`        | Coding › CLIs and extensions (install, accounts, extensions, MCP)      |
| `REinstellungen.dc.html` | Settings, reduced to app, people and operations                        |
| `RSuche.dc.html`         | ⌘K search                                                              |
| `RZustaende.dc.html`     | Empty and error states                                                 |
| `RMobil.dc.html`         | Phone: drawer as today, menu popover, long lists, agent access         |
| `RMobil2.dc.html`        | Phone: agents hub, teams, runtime, wizard                              |
| `RMatrixA.dc.html`       | Coverage: agents (old place → functions → new place)                   |
| `RMatrixB.dc.html`       | Coverage: rest, redirects, dual settings, behaviour changes            |

## 1. Problem and goal

Managing agents is spread over six places: Menü › Agenten, three settings tabs,
Accounts, Extensions and Projects. A fully set up agent needs about eleven pages. The
same word "Agent" means personal agents, Agency templates and CLI subagents. Things are
created in one place and granted in another; agent tabs group them arbitrarily (MCP
under Capabilities, SSH/GitHub/Secrets under Work); runtime settings sit three levels
deep; creating an agent covers only Profile and Capabilities.

Goal: organise by object, not by technology.

- The sidebar belongs to **agents and sessions**. They are always visible first.
- Everything else is in the **Menü popover**, grouped into **Arbeiten** (work) and
  **Einrichten** (set up).
- Shared credentials are created once under **Zugänge** and granted where they are
  used; both sides link to each other.
- An agent's settings get tabs by purpose; everything an agent may access is in one tab.
- Prerequisites are solved inline instead of sending the user elsewhere.

### Non-goals

- No change to chat, terminal, file explorer, pipelines internals, inbox logic,
  artifacts, the restricted-user app (`web/features/users/UserApp.jsx`) beyond links.
- No new permission semantics. Grants keep their current server rules, audit events
  and confirmations.
- **Out of scope:** rule-based grants ("all accesses in project X", variant C in
  `RGewaehren.dc.html`) and the unified grant sheet (variant B). Do not build them.
- No visual redesign of components: use `web/components/` as they are. Add a component
  only where section 5.5 asks for one.

## 2. Decisions made by the owner (binding)

1. **The menu stays a popover** on the "Menü" button in the sidebar head. It never
   becomes a permanent navigation list in the sidebar.
2. **Sidebar order stays as today:** head (collapse, Menü), brand, "Neu", "Eingang",
   then the **Agenten** group, then the **Sessions** group. On phones the drawer keeps
   today's look and order (brand + Menü, Neu, Agenten, Sessions).
3. **Menu content = variant A**: groups "Arbeiten" and "Einrichten" with status hints
   at the entries (section 5.1).
4. **Adding access from long lists = variant A**: an inline add field under every group
   in the agent's Access tab (section 5.5).
5. **Approved behaviour changes:**
   - "Agenten" stays in the menu when agents are disabled and leads to a page that
     offers "Agenten aktivieren" (today the entry disappears).
   - The new agent wizard creates the agent, its grants and an optional routine in one
     flow; when a later step fails, the agent stays and the failed steps are shown.
   - The advanced agent service values are shown inline on the Runtime tab instead of on
     their own subpage (the old URL keeps working).
   - The settings tab "Zugriff" disappears; its pages move to Zugänge, Coding and
     Einstellungen.
   - The CLI extensions tab "Agenten" is renamed to "Unteragenten" (EN "Subagents").
   - New: duplicate an agent, a teams overview across all agents, a "Speicher"
     (storage) row in Betrieb, ⌘K search.

## 3. Terminology (overrides mockup copy)

Follow `docs/ui-glossary.md`. It forbids "Sitzung", "Werkzeug", "Konten", and
"Verbindung" for provider connections (`tests/unit/i18n-terminology.test.js`). English
uses sentence case. Navigation paths use "›".

| Concept                         | German                        | English                 | Note                                                    |
| ------------------------------- | ----------------------------- | ----------------------- | ------------------------------------------------------- |
| Menu group: doing work          | Arbeiten                      | Work                    |                                                         |
| Menu group: configuring         | Einrichten                    | Set up                  |                                                         |
| Area for shared credentials     | **Zugänge**                   | Connections             | Mockups say "Verbindungen"; glossary term is "Zugang"   |
| Agents hub tabs                 | Alle Agenten · Teams · Vorlagen · Laufzeit | All agents · Teams · Templates · Runtime | "Vorlage" per glossary |
| Agent settings tabs             | Überblick · Identität · Fähigkeiten · Zugriffe · Team · Automatisierung · Kanäle | Overview · Identity · Capabilities · Access · Team · Automation · Channels | "Zugriffe" = what the agent may use |
| Section in Access tab           | Wer diesen Agenten nutzt      | Who uses this agent     | Users of this agent (moved from Profile)                |
| Coding page                     | CLIs & Erweiterungen          | CLIs and extensions     |                                                         |
| Coding tabs                     | Installation · Accounts · Erweiterungen · AgentPier als MCP | Installation · Accounts · Extensions · AgentPier as MCP | |
| CLI agent definitions (Agency)  | Unteragenten                  | Subagents               | Same term as `chat-observability` catalog               |
| Settings tabs                   | Allgemein · App & Benachrichtigungen · Benutzer · Fernzugriff · Betrieb | General · App and notifications · Users · Remote access · Operations | |
| Wizard capability profiles      | Gesprächspartner · Rechercheur · Assistent · Operator | Conversation partner · Researcher · Assistant · Operator | risk: gering/mittel/hoch, low/medium/high |
| Usage list                      | Benutzt von                   | Used by                 | existing term on Accounts                               |

Keep existing section names inside Zugänge to minimise churn: **Modell-Zugänge**,
**Dienste für Agenten**, **MCP-Server**, **SSH/SFTP-Zugänge** (today "SSH-Zugänge"),
**Geheimnisse**, **GitHub-Zugänge**. Reuse every existing message key whose text does
not change; move keys between catalogs only when needed.

## 4. Target information architecture and routes

### 4.1 Areas

| Area (menu entry)             | Group      | Route                                  | Replaces                                                                 |
| ----------------------------- | ---------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Übersicht                     | Arbeiten   | `/`                                    | unchanged                                                                |
| Projekte                      | Arbeiten   | `/projects…`                           | unchanged                                                                |
| Pipelines                     | Arbeiten   | `/pipelines…`                          | unchanged                                                                |
| Dateien                       | Arbeiten   | `/files…`                              | unchanged                                                                |
| Artifacts                     | Arbeiten   | `/artifacts…`                          | unchanged                                                                |
| Agenten                       | Einrichten | `/agents?tab=all\|teams\|templates\|runtime` | Menü › Agenten, Einstellungen › Agentendienst (+ Erweitert), Erweiterungen › Agenten (templates part) |
| CLIs & Erweiterungen          | Einrichten | `/coding/clis?tab=install\|accounts\|extensions\|mcp` and `/coding/clis/extensions/:profileId?tab=…` | Accounts › Native CLI-Accounts, Erweiterungen, Einstellungen › Zugriff › MCP, dashboard tool grid (stays on dashboard too) |
| Zugänge                       | Einrichten | `/connections?section=…&item=…&step=…` | Accounts › Modell-Zugänge, Dienste, MCP-Server; Einstellungen › Zugriff › SSH, Geheimnisse, GitHub |
| Einstellungen                 | Einrichten | `/settings…`                           | reduced (section 5.8)                                                    |

The Eingang stays in the sidebar (desktop) and in the mobile header; it is not repeated
in the menu. The agent chat, agent browser, team routes and restricted-user routes stay
unchanged.

### 4.2 Redirects (all preserve every query parameter not listed as renamed)

Implement in the client router (`web/app/routes.js` and the feature `routes.js` files),
the same way existing aliases (`/repositories`, `/plugins`, `/extensions?tab=mcp`) work.
Old URLs must render the new page with the correct tab or section, and `returnTo` must
survive. Add unit tests for every row.

| Old                                                        | New                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `/settings/assistants`                                     | `/agents?tab=runtime`                                     |
| `/settings/assistants-advanced`                            | `/agents?tab=runtime&section=advanced` (scrolls to group) |
| `/settings?tab=workspace`                                  | `/settings` (tab general)                                 |
| `/settings?tab=access`                                     | `/connections`                                            |
| `/settings/ssh`                                            | `/connections?section=ssh`                                |
| `/settings/secrets`                                        | `/connections?section=secrets`                            |
| `/settings/github`                                         | `/connections?section=github`                             |
| `/settings/mcp?cli&page&authorization`                     | `/coding/clis?tab=mcp&cli&page&authorization`             |
| `/accounts?section=models\|services\|mcp-servers&item&step` | `/connections?section=<same>&item&step`                   |
| `/accounts?section=cli&item`                               | `/coding/clis?tab=accounts&item`                          |
| `/accounts` (no section)                                   | `/connections`                                            |
| `/extensions[/:profileId]?tab=skills\|plugins\|marketplaces` | `/coding/clis/extensions[/:profileId]?tab=<same>`        |
| `/extensions[/:profileId]?tab=agents`                      | `/coding/clis/extensions[/:profileId]?tab=subagents`      |
| `/plugins[/:profile]`                                      | `/coding/clis/extensions[/:profile]?tab=plugins`          |
| `/agents/:id/settings?tab=profile`                         | `?tab=identity`                                           |
| `?tab=capabilities&page=memory\|allowlist\|skills`         | unchanged                                                 |
| `?tab=work&page=projects\|pipelines\|ssh\|github\|secrets` | `?tab=access&page=<same>`                                 |
| `?tab=work&team=<id>`                                      | `?tab=team&team=<id>`                                     |
| `?tab=work&page=actions` and `?tab=work` (no page)         | `?tab=overview&page=actions` / `?tab=overview`            |
| `?tab=routines[&page=hook&hook=<uuid>]`                    | `?tab=automation[&page=hook&hook=<uuid>]`                 |
| `?tab=telegram[&page=telegram-activity\|telegram-connection]` | `?tab=channels[&page=<same>]`                          |
| `/agents?new=1[&user][&template&revision]`                 | unchanged (opens the wizard)                              |

**MCP OAuth consent:** find where the server builds the consent/authorization URL for
CLIs (search `authorization` in `server/features/mcp*`, `server/http/`). Prefer leaving
the server URL as `/settings/mcp?authorization=…` and redirecting in the client. Add a
browser test that the consent screen still appears from the old URL. Any URL the server
puts into notifications, Telegram links, audit entries or docs must keep resolving.

Update cross-links: `useCrossLink` return targets (`web/app/cross-link.js`,
`returnTargets`, `originsFor`) must accept the new views (`connections`, coding,
agents runtime). Replace hard `href`s that point to moved pages (audit → MCP access,
session SSH dialog → SSH, dashboard gh → GitHub) with the new routes.

## 5. Screen specifications

General rules for every screen: settings pattern (group labels, list cards, rows,
save bar, unsaved-changes guard, conflict notice, `returnTo` back arrow), phone layout
≤700px as list → subpage, touch targets 44px, focus ring, no bespoke dialogs/menus.

### 5.1 Sidebar and menu popover (`RSidebar.dc.html`, `RMenue.dc.html` variant A, `RMobil.dc.html`)

Sidebar (desktop) – keep `web/app/Sidebar.jsx` structure:

- Head: collapse button, **search button** (opens ⌘K, aria-label "Suchen (⌘K)"), Menü
  button. Brand + LOKAL badge below.
- "Neu" button and its menu: unchanged (Session, Agent when agents enabled).
- "Eingang" row with count: unchanged.
- **Agenten** group: unchanged rows (agents, chats, team members toggle with
  Dauerhaft/Temporär, "Agenten von Benutzern", offline note). Add two icon buttons in
  the group head: grid icon → `/agents` ("Alle Agenten verwalten"), plus → wizard
  ("Neuer Agent"). Hidden while agents are disabled, as today.
- **Sessions** group: unchanged rows. Add two icon buttons in the group head: terminal
  icon → `/coding/clis` ("CLIs und Erweiterungen"), plus → LaunchDialog ("Neue Session").
- Footer: host status, unchanged.

Menü popover (`SidebarMenu.jsx`), same open/close/focus/Escape behaviour as today:

```
ARBEITEN
  Übersicht
  Projekte                [hint: n Entscheidungen]   (decisions / failed runs; reuse project list data)
  Pipelines               [hint: n läuft]            (running runs)
  Dateien
  Artifacts
EINRICHTEN
  Agenten                 [hint: Update bereit | aus | Dienst gestoppt]
  CLIs & Erweiterungen    [hint: n Update]           (outdated CLIs from tool status)
  Zugänge                 [hint: n Probleme]          (section 6.2 problem definition)
  Einstellungen           [hint: Update verfügbar]   (AgentPier update)
──────
Host status · Remote öffnen (same condition as today) · Abmelden
```

- Active area highlighted (`aria-current="page"`).
- Hints come from data the app already loads or loads cheaply when the menu opens.
  Never add a new polling loop. A failed source shows no hint, never a fake zero.
- "Agenten" is shown even when agents are disabled (hint "aus").
- Phone: the same popover in the drawer, full drawer width, with a search field as first
  row (opens ⌘K). The Eingang is not in the menu (it is in the mobile header).

### 5.2 Agents hub (`RAgenten.dc.html`, `RMobil2.dc.html`)

Route `/agents`. Header "Agenten" with lead text, buttons "Aus Vorlage" (→ tab
templates) and primary "Neuer Agent". Underline tabs with counts.

**Alle Agenten (`tab=all`, default):**

- Readiness list card (only rows that apply): agent service status with runtime
  version and "Update bereit" pill, link "Laufzeit"; web search not set up → link to
  Zugänge › Dienste; "n Freigaben warten auf dich" → inbox `tab=agents`.
- "Deine Agenten": one row per agent: avatar, name, model, status, pills for access
  summary and channels, buttons "Chat" and "Einstellungen". Agent without provider
  access shows "Provider-Zugang fehlt" and "Modell wählen" (→ settings Identity).
- "Agenten von Benutzern": own/shared, users count, link "Benutzer verwalten".
- "Archiv": archived agents and members, restore and "Browserprofil zurücksetzen".
- Keep today's AgentsPage behaviours (user agents open settings or "Meinen Chat öffnen"
  where they do today).

**Teams (`tab=teams`, new overview):** data from `GET /api/assistant-teams`. Segmented
Aktiv/Archiviert. Pending team proposals (approve/decline), team cards (lead, members,
report, "Im Chat zeigen", "Chat öffnen", "Team stoppen", archive/restore, team coding
requests), member requests (allow/deny). Same actions and endpoints as the team UI in
agent settings; reuse `TeamCard`, `TeamProposalCard`, `MemberRequests`. Hint with the
host-wide concurrent member limit linking to Runtime.

**Vorlagen (`tab=templates`):** the Agency catalog moved from Erweiterungen › Agenten:
search, Kategorie, "Katalog aktualisieren", paging, preview with scan verdict, source,
revision, license. Preview actions: **"Persönlichen Agenten anlegen"** (→ wizard with
template) and **"Als Unteragent in CLI installieren …"** (opens the CLI install flow of
Coding › Unteragenten for a chosen CLI). Blocked entries cannot be used.

**Laufzeit (`tab=runtime`):** content of today's Agentendienst page plus advanced:

- Funktion: "Agenten aktivieren" switch (moved from Einstellungen › Arbeitsbereich,
  same draft/apply/diagnostic behaviour, "Agenten-Diagnose" row).
- Agentendienst: status, aktivieren/neu starten/stoppen, technical details.
- OpenClaw-Updates: prepare, activate, recovery, phases.
- Teams: "Gleichzeitig aktive Mitglieder auf diesem Host".
- Träumen: switch, time, own time zone, the existing memory confirmation.
- Erweitert (inline group, anchor `section=advanced`): the six values with
  Sofort/Neustart nötig badges, ⓘ help, "Standard" reset, restart confirmation,
  unqualified-version note, stopped note.
- Speicher: "Installierte Abhängigkeiten der Agenten" with the existing cleanup flow
  from the system status dialog.
- Save bar per settings pattern; one draft for the tab, or separate drafts per group if
  the existing save chains require it (keep current server calls).

**Agents disabled:** `/agents` shows the empty state from `RZustaende.dc.html`
("Agenten sind ausgeschaltet", "Agenten aktivieren", progress during activation).
Only the Laufzeit tab is reachable; other tabs show the same state.

### 5.3 New agent wizard (`RNeu.dc.html`, `RMobil2.dc.html` phone 4)

Route unchanged (`/agents?new=1`, with `user`, `template`, `revision`). Steps in a left
rail on desktop, progress bar and one step per screen on phones. "Zurück"/"Weiter"
always available; steps 4 and 5 also "Überspringen". Draft survives opening a side
sheet (unsaved-changes guard on leaving the page).

1. **Start:** Leer / Aus Vorlage (TemplatePicker, scan, TemplateNote, block) /
   Duplizieren (pick an agent, section 5.3.1) · "Für" (Für mich / Benutzer) and "Art"
   (Eigener/Geteilter Agent) only when users exist. User agents: hint that shell, coding,
   pipelines, SSH, GitHub, secrets and teams stay locked.
2. **Identität & Modell:** Name, Anweisungen, Provider-Zugang, Modell (custom model ID,
   "Modelle aktualisieren"). "+ Modell verbinden" opens the existing model access flows
   (ChatGPT device code or provider connection) in a side sheet and returns.
3. **Fähigkeiten:** profile cards set the switches below; switches remain editable:
   - Gesprächspartner (gering): memory on; everything else off.
   - Rechercheur (gering): memory, reminders/routines, web search, read pages, read
     images, read PDFs on; browser, create images off; shell off.
   - Assistent (mittel): Rechercheur + browser on.
   - Operator (hoch): Assistent + shell "Mit Freigabe".
   Switches: Informationen merken, Erinnerungen und Routinen erlauben, Im Web suchen,
   Webseiten lesen, Bilder lesen, PDFs lesen, Einen Browser nutzen, Bilder erstellen
   (disabled with reason without ChatGPT account), Shell Aus/Mit Freigabe/Voller Zugriff
   (confirmation sheets as today; LockedNotice for user agents). Unavailable services
   show their reason and "hier einrichten" (side sheet), never block creation.
4. **Zugriffe (optional):** inline add fields (section 5.5) for projects (with
   Ordnerzugriff and coding start), MCP servers, pipelines, SSH/SFTP (with mode), GitHub
   level, secrets. Empty sources offer "+ … anlegen" in a side sheet.
5. **Kanäle & Routinen (optional):** Telegram bot token + connect (pairing afterwards),
   "Sich von selbst melden" with frequency and active window, one first routine
   (name, description, daily time, Telegram). Hooks are created after creation (they
   reveal a secret) – show the hint.
6. **Prüfen:** summary of every choice, open prerequisites, button "Agent anlegen".

Creation: `POST /api/assistants` (or the user-agent endpoint), then the existing
endpoints for capabilities, access/work grants, team policy, channels and routines, in
this order, each with its revision. On a failed later step: keep the agent, show the
step list with ✓/✕, "Erneut" per failed step and "Chat öffnen" (`RZustaende.dc.html`,
"Anlegen nur teilweise geklappt"). Never resend a step silently. Then open the chat.

#### 5.3.1 Duplicate

Copies: instructions (name "Kopie von <Name>"), model, capability switches, shell level,
enabled bundled skills, access grants (projects with levels, pipelines and their two
switches, MCP servers, SSH with mode, GitHub level and token profile, secrets), team
policy. Does **not** copy: memory, chats, attachments, Telegram, hooks, reminders,
routines, shell allowlist, browser profile, users, template provenance. Duplicate opens
the wizard prefilled so the owner reviews every step. Entry points: wizard Start,
agent Overview › Verwalten.

### 5.4 Agent settings (`RAgent.dc.html`)

Route `/agents/:id/settings?tab=…&page=…`. Header: back to agents, avatar, name,
status line, "Chat öffnen", overflow (Duplizieren, Archivieren/Wiederherstellen).
PendingRestartNotice. Right aside "Agentendienst" (on phones inside Overview, as today
inside Profile). Each tab keeps its own draft, save bar ("Agent speichern", "Gilt ab der
nächsten Nachricht"), conflict notice and unsaved-changes guard.

Tabs and their content (every item exists today unless marked NEW):

- **Überblick (overview):** "Wartet auf deine Freigabe · n" → `page=actions`;
  "Aktionen und Coding-Aufträge (n)" → `page=actions` (moved from Arbeit, unchanged
  subpage); "Auf einen Blick" summary rows linking to the tabs (NEW, read-only); Chat-
  Anhänge (usage, "Anhänge leeren" with confirm); Team-Mitglied group for members
  (inherited info, changes, history, "Mitglied stoppen", "Als dauerhaften Agenten
  behalten", restart service); Verwalten: Duplizieren (NEW), Archivieren/Wiederherstellen.
- **Identität (identity):** Name, Anweisungen, "Dem Modell des leitenden Agenten folgen"
  (temporary members), Provider-Zugang + Modell (custom ID, "Modelle aktualisieren"),
  ReferenceRow "Zugänge verwalten" → Zugänge › Modell-Zugänge, "Als geprüft markieren",
  TemplateNote, revision line.
- **Fähigkeiten (capabilities):** Gedächtnis & Erinnerungen (with dreaming lock, Notizen
  → `page=memory`), Web & Dokumente (six switches with reasons, ReferenceRows
  Suchanbieter and PDF-Ersatzmodell → Zugänge › Dienste), Browser des Agenten (visible
  browser, install, restart service, live view, reset profile, uploads note), Shell
  (segmented + `page=allowlist`), Skills (`page=skills`), OwnContentNotice. MCP moves out.
- **Zugriffe (access):** groups with inline add (section 5.5):
  Projekte (coding start + Ordnerzugriff per project, "Vorschläge zum Ändern von
  Projektwissen erlauben"; note "gleiche Einstellung wie Projekt › Agenten"), SSH/SFTP
  (mode per host: Mit Freigabe / Vertraut / Vertraut inkl. Routinen; removed hosts
  notice), MCP-Server (per server status, "Öffnen" → Zugänge item, OAuth hint), Pipelines
  (selection, "ohne zusätzliche Freigabe starten", "Pull Requests veröffentlichen
  erlauben"), GitHub (Kein/Lesen/Lesen und schreiben, Tokenprofil, missing-scope
  warnings, GitHub MCP server install state with retry), Geheimnisse (global/project,
  Telegram-senders note). "Vom leitenden Agenten gewährt/geteilt" with "Widerrufen" for
  members. **Wer diesen Agenten nutzt** (moved from Profile): level per user, remove,
  "Freigegebene Fähigkeiten". Each long group shows the first entries plus "n weitere ·
  Alle anzeigen" which opens today's full subpage (`page=projects|pipelines|ssh|github|
  secrets`, kept with search). Empty sources: "… einrichten" cross-link to Zugänge.
  User agents: only projects (folders), LockedNotice for the rest.
- **Team:** Team nutzen (Auf Anfrage / Vorschlagen / Selbstständig), "Teams ohne
  erneute Rückfrage erlauben", "Team-Mitglieder dürfen Shell und SSH nutzen", "Maximale
  Teamgröße", "Laufzeit pro Mitglied (Minuten)"; "Mit Mitgliedern geteilt" (lead shares,
  end sharing); Teams (Aktiv/Archiviert, proposals, cards, member requests, `team=`
  focus). Hidden for members and user agents, as today.
- **Automatisierung (automation):** Von sich aus handeln (all heartbeat fields),
  Erinnerungen, Routinen (with run history), Hooks (+ modal, secret reveal,
  `page=hook`). Same restrictions for shared/user agents as today.
- **Kanäle (channels):** Telegram connection group with every current control and the
  two subpages, ReferenceRow Spracherkennung → Zugänge › Dienste, "Telegram für andere
  Personen", NEW read-only row linking to Einstellungen › App & Benachrichtigungen.

Variants: temporary members see Überblick, Identität, Fähigkeiten, Zugriffe (read-only
grants from the lead). User agents have no Team tab and keep all current LockedNotices.

### 5.5 Inline add field (new shared component)

Add `web/components/AddPicker.jsx` (name may follow local conventions), document it in
`docs/ui-guide.md` and add it to the component gallery (`web/features/gallery/`) in the
same PR (AGENTS.md rule for new primitives).

- Renders as the last row of a list card: plus icon + text input with placeholder
  "<Typ> hinzufügen …".
- Typing filters candidates (client-side for already loaded lists, debounced server
  search where a list endpoint supports it). Shows "n Treffer".
- Opens an attached listbox: multi-select rows with checkbox, name, monospace subline
  (host, package, path), project. Already granted items are shown disabled with
  "hat er schon" (EN "already granted").
- For typed grants a "Modus" select applies to all new items (SSH mode, folder level);
  each item can be changed after adding.
- Footer: "Abbrechen", primary "n hinzufügen". Adding writes into the tab draft; the
  save bar saves as usual.
- Accessibility: ARIA 1.2 combobox + listbox with `aria-multiselectable`, arrow keys,
  Space toggles, Enter adds, Escape closes and returns focus, 44px rows on touch.
- Reused in the wizard step 4 and in Zugänge "Benutzt von" ("Agent hinzufügen …").

### 5.6 Zugänge (`RVerbindungen.dc.html`, `RVollansicht.dc.html`, `RMobil.dc.html` phone 3)

Route `/connections`. Built from the Accounts hub (`web/features/accounts/`) plus the
SSH, secrets and GitHub pages. Desktop: categories column, list, detail pane. Phone:
categories → list → detail as subpages.

- **Categories column:** Modell-Zugänge, Dienste für Agenten, MCP-Server, SSH/SFTP-
  Zugänge, Geheimnisse, GitHub-Zugänge, each with count and a warning count (section
  6.2). Dienste and ChatGPT entries hidden while agents are off (as today).
- **List view** (long lists): fixed views "Alle", "Mit Problemen · n", "Nicht benutzt ·
  n" (and "Heute benutzt" only if last use is available, see 6.3); search over name,
  host, user, command/URL; filter chips (SSH: Projekt, Typ, Benutzt von, Status; MCP:
  Transport, CLI, Agent, Status); group by (SSH: Projekt; MCP: Quelle) with collapsible
  groups showing the first 5 entries and "Weitere n anzeigen"; sort (Name, Zuletzt
  geändert, Zuletzt benutzt if available). Dense rows: checkbox, name + monospace
  subline, type badge, used-by summary, status, last column. Keyboard: arrows move,
  Space selects. Must stay responsive with 500 entries.
- **Bulk actions** (bar appears with selection): SSH – "Agent freigeben …" (agent
  multi-select + mode), "Testen" (sequential with progress, at most 2 in parallel),
  "Projekt zuweisen …", "Entziehen …", "Löschen" (confirm sheet listing affected agents,
  hooks, sessions). MCP – "An CLI binden …", "Agent freigeben …", "Updates prüfen",
  "Entfernen". Every bulk action calls the existing per-item endpoints, reports per-item
  failures and never retries silently.
- **Detail pane:** facts, "Benutzt von" with grant/revoke and mode, buttons (test/check,
  edit, "Vollansicht").
- **Full view** (`item=<id>`): today's complete forms and flows for each type
  (Appendix A rows Z-*), plus "Benutzt von" with inline add, last test box with the
  server's error message (SSH), Verwalten (Aktivitätsprotokoll link filtered to the item
  if the audit filter supports it, Projektressourcen neu zuweisen, Löschen).
- **MCP server wizard** and saved-server overview move unchanged
  (`web/features/mcp-servers/wizard`), including every step, OAuth result banner,
  "Gefunden in CLIs", package panel, per-CLI status, Codex account login.
- Empty and error states: `RZustaende.dc.html`.

### 5.7 Coding › CLIs & Erweiterungen (`RCoding.dc.html`)

Route `/coding/clis`. Underline tabs:

- **Installation:** the dashboard tool grid (install/update/start CLIs, gh → GitHub-
  Zugänge, Chromium remove with confirm, nono, Shell). The dashboard keeps its grid.
- **Accounts:** native CLI accounts with every current control (login terminal,
  "Als Standard verwenden", name, tool, API key, legacy provider binding editor, Benutzt
  von, delete), list → detail like today.
- **Erweiterungen:** profiles column (ProfileSwitcher sheet on phones), segmented Skills
  · Plugins · Marketplaces · **Unteragenten** (renamed from Agenten), counts, all current
  flows (skill install with scan, plugin catalog/npm, marketplaces, Agency install/
  remove), McpReferenceRow → Zugänge › MCP-Server, shared-profile import banner.
  Unteragenten preview also offers "Persönlichen Agenten anlegen" (as today).
- **AgentPier als MCP:** connect a coding CLI (address, CLI tabs with copy blocks, docs
  link, HTTPS setup hint), consent screen (`authorization`), connected clients with
  revoke and paging.

### 5.8 Einstellungen (`REinstellungen.dc.html`)

Tabs: **Allgemein** (Sprache, Standard-Arbeitsverzeichnis, Unterbrochene Sessions
fortsetzen, MCP-Verzeichnis with registry address; "Funktionen" row "Agenten · An" →
Agenten › Laufzeit; group "Umgezogen" with three link rows to the moved pages, shown for
two releases), **App & Benachrichtigungen** (unchanged content of
`/settings/notifications`), **Benutzer** (unchanged `/settings/users` incl. `?user=`),
**Fernzugriff** (unchanged `/settings/remote`), **Betrieb** (Diagnose, Sicherungen,
Updates, Aktivitätsprotokoll, NEW row "Speicher" opening the system status cleanup,
Entwicklung › Komponenten). Subpage routes stay; only tab grouping and summaries change.
Update `settingsSectionGroups` and summary rows (`/settings/summary`) accordingly.

### 5.9 ⌘K search (`RSuche.dc.html`)

- Opens from the sidebar search button, the phone menu search row, and ⌘K (macOS) /
  Ctrl+K (others). Do **not** capture the shortcut while focus is in a terminal, the
  code editor or any text input that uses it.
- Index (client-side): every area, tab, settings group and subpage with DE and EN
  labels plus old labels as aliases ("Einstellungen › Zugriff › SSH-Zugänge"); agents
  and their tabs (from the loaded agent list); connections names loaded lazily on first
  open; actions ("SSH-Zugang hinzufügen", "Neuer Agent", "Neue Session").
- Results grouped (Seiten, An Agenten, Aktionen), each with its path; arrows, Enter,
  Escape. Dialog per ui-guide (no bespoke dialog).

### 5.10 States (`RZustaende.dc.html`)

Implement: agents disabled, activation progress, no agent yet (prerequisite checklist +
three starts), empty connection category, no search results (reset filters), agent
service stopped (banner with start/diagnose; sidebar agents dimmed "offline"), SSH test
failed (server message + hint), host key changed (only if the server already reports
this case – reuse `server/features/ssh/ssh-errors.js`; do not invent new server
states), wizard partially failed. Keep existing offline, locked and "Bereits erledigt"
states.

## 6. Backend work

Keep it small and read-only where possible. Follow existing patterns.

### 6.1 Connection usage (required)

Add a "Benutzt von" aggregation for SSH/SFTP accesses, secrets and GitHub token
profiles, modelled on `server/features/accounts/account-usage.js` (`/api/accounts/usage`):

- Per item: agents (id, name, kind, mode/level, via: own grant | lead share | hook),
  hooks (agent id, hook id, name), pipelines where applicable, active session count.
- Read only while the agents feature runs for agent data; a failing source yields
  `null`, never a fake 0.
- Route e.g. `GET /api/connections/usage` (register in `server/http/api-registry.js`,
  route inventory and access rules; owner only). Integration tests for each source.

### 6.2 Problem status (required)

"Mit Problemen" and menu hints count: SSH last test failed or host key mismatch;
MCP OAuth expired, update available, installation error; model account check failed;
GitHub token check failed or missing scopes; web search not configured (warning only).
Persist the **last SSH connection test result** (ok/failed, time, sanitized message –
no secrets, no full command output with credentials) when `POST /api/ssh-accesses/:id/
test` runs, and expose it in the SSH list response. Backup/restore must include or
safely ignore the new field (`ssh-catalog`, `sftp-backup.js`).

### 6.3 Last use (optional)

Show "Zuletzt benutzt" and the view "Heute benutzt" only if last use can be derived
cheaply from existing data (SSH receipts, audit). Otherwise omit both and say so in the
PR. Do not add new tracking just for this.

### 6.4 Everything else uses existing endpoints

Grants from both sides use the existing agent endpoints (`PUT /api/assistants/:id/work`,
`PUT /api/assistants/:id/access`, `PUT /api/assistant-project-access/:projectId/:id`,
MCP server `clis` and agent bindings) with their revisions and audit events. Teams:
`GET /api/assistant-teams`. Wizard and duplicate orchestrate existing endpoints from the
client. If an existing endpoint cannot express a needed grant, stop and describe it in
the PR instead of widening permissions.

## 7. Acceptance criteria

Each criterion needs a test (unit, integration or browser) unless marked (manual).

**Navigation**
- AC-NAV-1 The sidebar shows, in order: head (collapse, search, Menü), brand, Neu,
  Eingang, Agenten group, Sessions group, host status. No permanent area navigation.
- AC-NAV-2 The Menü popover lists exactly the entries of 5.1 in groups Arbeiten and
  Einrichten, marks the current area, closes on Escape, outside click and navigation,
  and returns focus to the button.
- AC-NAV-3 Menu hints appear only when their source reports something; a failing source
  shows no hint.
- AC-NAV-4 "Agenten" is in the menu while agents are disabled and leads to the
  activation state; the Agenten sidebar group stays hidden while disabled.
- AC-NAV-5 Agenten and Sessions group heads have the two icon buttons with accessible
  names and correct targets.
- AC-NAV-6 On a 390px viewport the drawer shows brand + Menü, Neu, Agenten, Sessions in
  today's look; the menu popover opens inside the drawer with search first.

**Routes**
- AC-RT-1 Every row of 4.2 redirects with its parameters; unit tests per row.
- AC-RT-2 `returnTo` survives redirects; back arrows from moved pages return to the
  origin (browser test for agent → Zugänge → back).
- AC-RT-3 The MCP consent screen opens from `/settings/mcp?authorization=…`.
- AC-RT-4 No hard `href` in `web/` points to a removed route
  (`grep` check or unit test over route inventory).

**Agents hub**
- AC-AH-1 Tabs all/teams/templates/runtime render and are deep-linkable via `tab=`.
- AC-AH-2 Teams tab shows teams of all agents with all team actions working.
- AC-AH-3 Templates tab offers both "Persönlichen Agenten anlegen" and "Als Unteragent
  in CLI installieren"; blocked entries cannot be used.
- AC-AH-4 Runtime tab contains every control of the old Agentendienst page and the six
  advanced values with badges; `section=advanced` scrolls to them.
- AC-AH-5 Enabling and disabling agents works from Runtime with the existing diagnostic.

**Wizard**
- AC-WZ-1 All six steps; skip on 4 and 5; draft kept when a side sheet opens.
- AC-WZ-2 Profiles set exactly the switches in 5.3; switches remain editable.
- AC-WZ-3 Template, user agent (own/shared, locks) and duplicate paths work; duplicate
  copies exactly the list in 5.3.1 and nothing else.
- AC-WZ-4 One click creates agent + grants + optional channel + routine; a failing step
  leaves the agent, shows ✓/✕ per step and allows retry per step (test with a mocked
  failure).
- AC-WZ-5 Missing model access can be fixed in a side sheet without losing the draft.

**Agent settings**
- AC-AS-1 Seven tabs with the content of 5.4; every old tab/page deep link lands on the
  new tab (4.2).
- AC-AS-2 MCP grants, projects, pipelines, SSH, GitHub and secrets are all in Zugriffe;
  "Wer diesen Agenten nutzt" is in Zugriffe; nothing of it remains elsewhere.
- AC-AS-3 Inline add works for every group: filter, multi-select, already granted
  disabled, mode, add into draft, save; keyboard-only operation (browser test).
- AC-AS-4 Temporary member and user agent variants show the right tabs and locks.
- AC-AS-5 Per-tab drafts, conflict notices and unsaved-changes guards behave as before.

**Zugänge**
- AC-ZG-1 All six categories with counts and warning counts; services/ChatGPT hidden
  while agents are off.
- AC-ZG-2 SSH and MCP lists: views, search, filters, grouping with "Weitere n
  anzeigen", sort, selection and every bulk action of 5.6 with per-item results.
- AC-ZG-3 Responsive with 500 synthetic SSH entries (browser test or perf unit test).
- AC-ZG-4 "Benutzt von" shows agents (with mode), hooks, pipelines and sessions; grant
  and revoke from here change the same setting as the agent's Access tab (test both
  directions).
- AC-ZG-5 Every flow of the old Accounts, SSH, secrets and GitHub pages exists
  (Appendix A rows Z-*), including the MCP wizard steps and OAuth return.
- AC-ZG-6 The last SSH test result is persisted, shown in list and detail, contains no
  secret, and survives restart; backup/restore stays green.

**Coding, settings, search, states**
- AC-CD-1 Coding › CLIs & Erweiterungen has the four tabs with all old functions;
  "Unteragenten" replaces "Agenten"; dashboard grid still works.
- AC-ST-1 Settings has the five tabs; nothing of Arbeitsbereich/Zugriff is lost; "Umgezogen"
  rows link correctly; "Speicher" opens the cleanup.
- AC-SR-1 ⌘K/Ctrl+K opens search except in terminal/editor focus; finds areas, tabs,
  agents, old names and actions; keyboard navigation and Escape work.
- AC-SR-2 Search button in the sidebar and in the phone menu opens the same search.
- AC-STA-1 Every state of 5.10 renders with its action (browser or component test).

**Quality gates**
- AC-Q-1 `npm run check` passes; `npm run test:e2e` passes on Chromium; affected specs
  updated rather than deleted.
- AC-Q-2 `tests/unit/ui-guide-rules.test.js` passes without growing its allowlist; no new
  hex colours, font sizes <11px or breakpoints.
- AC-Q-3 DE and EN catalogs have matching keys; glossary tests pass; `npm run
  i18n:confirm` run and `translation-lock.json` committed; UI exercised in English.
- AC-Q-4 No source or test file above 600 lines (`check:structure`).
- AC-Q-5 Every row of Appendix A verified; the PR description contains the checklist
  with ✓ per row.
- AC-Q-6 Documentation updated (section 9) and screenshots with synthetic data attached
  for every changed screen, desktop and phone.
- AC-Q-7 This spec folder is deleted in the final commit.

## 8. Test plan

- **Unit:** route parsing/building and every redirect; settings tab grouping; menu
  model (entries, hints, disabled agents); wizard profile mapping and duplicate copy
  rules; inline add filtering/selection reducer; search index (aliases, both languages);
  usage aggregation; SSH test result sanitising.
- **Integration:** `/api/connections/usage` per source with agents on/off and failing
  sources; SSH test persistence; access rules (owner only).
- **Browser (update existing, add new):** `navigation.spec.js`, `remote-menu.spec.js`,
  `accounts-*.spec.js`, `assistant-settings*.spec.js`, `agent-settings-teams.spec.js`,
  `agent-mcp-servers.spec.js`, `assistant-advanced-settings.spec.js`,
  `assistant-agent-templates.spec.js`, `extensions*.spec.js`, `mcp-settings.spec.js`,
  `secrets-settings.spec.js`, SSH settings specs, `projects-agents*.spec.js`,
  `owner-user-agents.spec.js`, `assistant-settings-mobile.spec.js`; search all specs for
  old labels and paths (`rg "Einstellungen ›|/settings/(ssh|secrets|github|mcp|assistants)|/accounts|/extensions|tab=work|tab=routines|tab=telegram|tab=profile" tests`). New specs: menu
  popover, agents hub tabs, wizard happy path + partial failure, inline add (keyboard),
  connections long list + bulk, ⌘K, redirects, phone drawer (390×844).
- Run `npm run test:affected`, then the full `npm test` and `npm run test:e2e`.

## 9. Documentation to update in the same PR

Search `docs/`, `README.md`, `README.de.md` for every moved label and path
(`rg "Settings →|Settings ›|Einstellungen ›|Accounts →|Accounts ›|Extensions ›|Agent service|Work →|Routines & check-ins|Profile tab"`) and update: `docs/agents.md` (largest),
`docs/mcp.md`, `docs/ssh-access.md`, `docs/sftp-access.md`, `docs/secrets.md`,
`docs/github-agents.md`, `docs/providers.md`, `docs/users.md`, `docs/inbox.md`,
`docs/operations.md`, `docs/system-status.md`, `docs/remote-access.md`,
`docs/notifications.md`, `docs/assistant-runtime-updates.md`,
`docs/shared-cli-extensions.md`, `docs/settings-pattern.md` (routes, cross-links),
`docs/ui-guide.md` (new component, navigation section), `docs/ui-glossary.md` (Zugänge
area, Unteragenten, Arbeiten/Einrichten, agent tab names), `docs/README.md`, both
READMEs. Add an ADR `docs/adr/0005-navigation-information-architecture.md` with the
decisions of section 2. Keep public heading anchors stable. Replace or regenerate
affected screenshots under `docs/screenshots/` with synthetic data.

## 10. Suggested commit sequence (one PR, linear history)

1. `feat: add route aliases for the new areas` – route model, redirects, tests.
2. `feat: add connection usage and last SSH test result` – backend 6.1/6.2 + tests.
3. `feat: add the inline add picker component` – component, gallery, ui-guide.
4. `feat: move shared credentials into Zugänge` – connections area, lists, bulk, full view.
5. `feat: split agent settings into seven tabs` – tabs, moves, inline add.
6. `feat: add the agents hub with teams, templates and runtime`.
7. `feat: replace agent creation with the wizard` – incl. duplicate.
8. `feat: move CLI pages into Coding` – CLIs & Erweiterungen, Unteragenten.
9. `feat: regroup settings and the menu popover` – menu A, hints, sidebar icons, settings tabs.
10. `feat: add ⌘K search` and `feat: add empty and error states`.
11. `chore: update docs, glossary, ADR and screenshots`.
12. `chore: remove the redesign spec`.

## 11. PR description template

Title: `feat: reorganize navigation and agent management`

Body: problem (section 1), resulting behaviour (areas, menu, agent tabs, wizard,
Zugänge, Coding, settings, search), the approved behaviour changes (section 2.5),
backend changes, redirects, validation (commands run, browsers, viewports), Appendix A
checklist with ✓, docs checked/updated, screenshots desktop + phone, known limitations
(e.g. 6.3 omitted). End with the attribution lines required by the session.

## Appendix A – Coverage checklist (nothing may be lost)

Format: **today's place** → functions → **new place**. Tick every row in the PR.

### Navigation and shell

- [ ] N-1 Sidebar collapse, brand + LOKAL → overview → unchanged.
- [ ] N-2 Menü: Übersicht, Artifacts, Projekte, Dateien, Pipelines, Accounts (count),
  Erweiterungen, Einstellungen, host status, Remote öffnen (localhost + remote URL),
  Logout → Menü A (5.1); Accounts/Erweiterungen replaced by Zugänge and CLIs &
  Erweiterungen; count moves to hints.
- [ ] N-3 Neu menu: Session (LaunchDialog), Agent (only when enabled) → unchanged.
- [ ] N-4 Eingang entry with count; mobile header inbox button → unchanged.
- [ ] N-5 Agent group: rows, chats, team members toggle (Dauerhaft/Temporär), team
  rows → `/agents/:id/teams/:tid`, Agenten von Benutzern, offline note, click rules
  (members/missing access/user agents open settings) → unchanged + head icons.
- [ ] N-6 Sessions group: legacy tmux notice, rows, hidden stopped headless pipeline
  sessions → unchanged + head icons.
- [ ] N-7 Mobile header, drawer, Escape one layer at a time → unchanged.
- [ ] N-8 Legacy aliases `/repositories`, `/memory`, `/agentbus`, `/plugins`,
  `/extensions?tab=mcp`, `/#<sessionId>`, `/sessions/:id/chat` → still work.

### Dashboard and sessions

- [ ] D-1 Hero, tool grid (install/start/update CLIs, gh → GitHub, Chromium remove),
  system status meters and dialog (history, processes, data areas, cleanup), disk
  warning, counts → unchanged; tool grid also in Coding › Installation; cleanup also via
  Betrieb › Speicher and Laufzeit › Speicher.
- [ ] D-2 Session header actions (reload & continue, account switch, AgentPier tools,
  SSH accesses dialog with "verwalten", rename, stop/remove), modes, artifacts panel,
  GitHub status, pipeline recovery, mobile key toolbar, LaunchDialog fields → unchanged;
  "verwalten" → Zugänge › SSH/SFTP.

### Agents

- [ ] A-1 `/agents` cards, status, chat/settings buttons, "Agentendienst-Einstellungen",
  "Neuer Agent", user agents section, AgentsOff page → Agenten › Alle Agenten; off state
  per 5.2.
- [ ] A-2 Create: template bar, TemplatePicker (search, category, paging, preview,
  scan, block), Für/Art, Profil fields, Fähigkeiten (memory, web, proactive preview,
  shell, LockedNotice), "Agent anlegen" → wizard steps 1–3 (+4–6 new).
- [ ] A-3 Agent chat, browser view, chat list sheet, composer options, strips → unchanged.
- [ ] A-4 Settings header, back, PendingRestartNotice, RuntimeSummary aside (mobile in
  Profile) → header + aside (mobile in Overview).
- [ ] A-5 Profil: name, instructions, follow lead model, provider access + model, custom
  ID, refresh models, "Zugänge verwalten", "Als geprüft markieren", TemplateNote,
  revision → Identität.
- [ ] A-6 Profil › Team-Mitglied (info, history, restart, stop, keep permanent,
  archive/restore) → Überblick.
- [ ] A-7 Profil › Benutzer dieses Agenten (levels, remove, released capabilities) →
  Zugriffe › Wer diesen Agenten nutzt.
- [ ] A-8 Profil › Chat-Anhänge (usage, clear) → Überblick.
- [ ] A-9 Fähigkeiten: memory switch with dreaming lock + `page=memory` (note types,
  edit, clear draft, reload, search, save, read-only cases); reminders switch → Fähigkeiten.
- [ ] A-10 Fähigkeiten: six web/document switches with reasons; ReferenceRows search
  provider and PDF model → Fähigkeiten; targets → Zugänge › Dienste.
- [ ] A-11 Fähigkeiten: browser group (visible, install, restart, live view, running,
  reset profile) → Fähigkeiten.
- [ ] A-12 Fähigkeiten: shell segmented with confirms, `page=allowlist` (entries,
  delete) → Fähigkeiten.
- [ ] A-13 Fähigkeiten: Skills `page=skills` (search, filter, toggles) → Fähigkeiten.
- [ ] A-14 Fähigkeiten: MCP servers (checkbox, OAuth, stdio, manage link, empty hint) →
  Zugriffe › MCP-Server.
- [ ] A-15 Fähigkeiten (temporary member): granted/shared by lead, revoke, temporary MCP
  → Zugriffe.
- [ ] A-16 OwnContentNotice → each affected tab.
- [ ] A-17 Arbeit: waiting strip and `page=actions` (all card types and actions) →
  Überblick.
- [ ] A-18 Arbeit: projects `page=projects` (coding + folder level, warning) → Zugriffe ›
  Projekte (inline add + full subpage).
- [ ] A-19 Arbeit: pipelines `page=pipelines`, "ohne zusätzliche Freigabe", "PRs
  veröffentlichen", "Vorschläge Projektwissen" → Zugriffe.
- [ ] A-20 Arbeit: SSH `page=ssh` (search, hosts, mode, removed hosts, setup link) →
  Zugriffe › SSH/SFTP.
- [ ] A-21 Arbeit: GitHub `page=github` (level, token profile, scope warnings, GitHub MCP
  install + retry, setup link) → Zugriffe › GitHub.
- [ ] A-22 Arbeit: secrets `page=secrets` (search, global/project, Telegram note, setup
  link) → Zugriffe › Geheimnisse.
- [ ] A-23 Arbeit: shared by lead (permanent members) → Zugriffe.
- [ ] A-24 Arbeit: Team group (use team, no re-ask, shell/SSH for members, max size,
  runtime) → Team.
- [ ] A-25 Arbeit: Teams (filter, proposals, cards, report, stop, archive, coding
  requests, member requests, `team=`) → Team (+ Agenten › Teams).
- [ ] A-26 User agents: LockedNotices, blocked pages → unchanged in new tabs.
- [ ] A-27 Routinen: heartbeat (all fields, cost note, needs memory) → Automatisierung.
- [ ] A-28 Routinen: reminders (create, one-time/daily, time zone, Telegram, pause,
  remove, history, review) → Automatisierung.
- [ ] A-29 Routinen: routines (create/edit, trigger daily/event, write permission,
  pause, run once, remove, run history) → Automatisierung.
- [ ] A-30 Routinen: hooks (+ modal, secret reveal, `page=hook` with instruction, run
  rights, shell, SSH hosts, folders, wake-ups/hour, enabled, addresses, regenerate
  secret, test event, delete), shared/user agent rules → Automatisierung.
- [ ] A-31 Telegram: connect, status, pause/resume, disconnect, notice language, link
  address, activity + connection subpages (retry, confirm, new pairing code, replace
  token), pairing, speech ReferenceRow, Telegram for other people (token, allowed people,
  apply now, voice note), user agent notes → Kanäle.
- [ ] A-32 Einstellungen › Arbeitsbereich › Agenten aktivieren + Agenten-Diagnose →
  Laufzeit › Funktion.
- [ ] A-33 Agentendienst: status, enable/restart/stop, details; OpenClaw updates;
  concurrent members; Träumen (+ confirm); "Erweitert" row → Laufzeit.
- [ ] A-34 Agentendienst › Erweitert: six values, badges, help, reset, restart confirm,
  notes → Laufzeit › Erweitert (inline).
- [ ] A-35 Erweiterungen › Agenten (Agency: installed/catalog, search, category,
  refresh, paging, preview, install for CLI, "Agent anlegen", remove) → Agenten ›
  Vorlagen (create) + Coding › Unteragenten (install/remove).
- [ ] A-36 Projekt › Agenten tab (coding start, folder level, lead shares revoke,
  LockedNotice) and "Ordner hinzufügen" agent access → unchanged, same setting as
  Zugriffe › Projekte.
- [ ] A-37 Restricted user app → unchanged.

### Zugänge

- [ ] Z-1 Modell-Zugänge: list with used-by counts, "+ Provider-Zugang hinzufügen",
  detail (name, provider types, API key, Responses confirmation, custom endpoint server
  type, base URLs, auth header, test, routes per CLI, adapter options, model table),
  delete with affected agents + restart, Benutzt von, compatible CLIs → Zugänge ›
  Modell-Zugänge.
- [ ] Z-2 ChatGPT für Agenten: device-code login, open page, cancel, offline note,
  account status, check, sign out, Benutzt von → Zugänge › Modell-Zugänge.
- [ ] Z-3 Dienste: speech (Deepgram key, model, language, send dictation at once,
  remove), web search (provider radio, Perplexity connection, Brave key, status, restart
  confirm), PDF fallback model → Zugänge › Dienste für Agenten.
- [ ] Z-4 MCP-Server: list, transport/stdio/update badges, "Gefunden in CLIs" (adopt
  each/all), OAuth banner, wizard (source, directory, package, remote, command, paste,
  settings, install, review, connect, done, discard sheet), saved overview (cards with
  change, agent folders, package panel incl. bundled skills → install in CLI profile,
  per-CLI status, Codex logins, OAuth sign in/out, lead shares revoke, remove), edit
  steps → Zugänge › MCP-Server.
- [ ] Z-5 SSH-Zugänge: tabs accesses/keys, add buttons, search, project filter, detail
  (edit, test, view key), form (project, SSH/SFTP, host/user/port, remote folder, key or
  password, legacy algorithms, interactive shell, fetch host key), key card (fingerprint,
  copy, download private, edit, delete), key form (generate ed25519, import), reassign
  project resources → Zugänge › SSH/SFTP-Zugänge.
- [ ] Z-6 Geheimnisse: add, list + detail, name, description, project, value
  replace/keep, delete → Zugänge › Geheimnisse.
- [ ] Z-7 GitHub-Zugänge: token profiles (access, status, commit identity, agent badge,
  check, edit, delete), add dialog (name, host, commit name/email, token, default for
  agents) → Zugänge › GitHub-Zugänge.
- [ ] Z-8 Einstellungen › Zugriff summary row "Provider-Zugänge, MCP-Server" → removed
  (menu entry Zugänge).

### Coding

- [ ] C-1 Native CLI-Accounts (all controls) → CLIs & Erweiterungen › Accounts.
- [ ] C-2 Erweiterungen (profiles, shared mode, import banner, tabs with counts, skills
  incl. scan, plugins incl. catalog/npm/detail/catalog account, marketplaces,
  McpReferenceRow) → CLIs & Erweiterungen › Erweiterungen.
- [ ] C-3 Einstellungen › Zugriff › MCP & Zugriffe (connect CLI, copy blocks, consent,
  connected clients, revoke, paging) → CLIs & Erweiterungen › AgentPier als MCP.
- [ ] C-4 Projekte, Pipelines (all tabs, dialogs, builders, queue) → unchanged.

### Einstellungen and the rest

- [ ] S-1 Arbeitsbereich: language, default directory, auto-resume, MCP directory
  (registry search, address, official registry), save bar → Allgemein.
- [ ] S-2 App & Benachrichtigungen (app install, device notifications, name, test,
  devices, device preferences modal) → tab App & Benachrichtigungen.
- [ ] S-3 Fernzugriff (local, Tailscale, network switch with warning, bind address,
  extra hosts, addresses, save, restart) → tab Fernzugriff.
- [ ] S-4 Benutzer (create, list, `?user=` detail, account, levels, create agent for
  person, add to shared agent, delete with own-agents choice) → tab Benutzer.
- [ ] S-5 Betrieb: Diagnose (scope, DB check, report), Sicherungen (`?job=`, prepare,
  verify/restore, download, delete, backup form, restore form, imported AgentBus
  history), Updates (channel, check, prepare, activate, delete old, sessions migration,
  orphan processes, history, rollback), Aktivitätsprotokoll (filters, paging, MCP link),
  Komponenten → tab Betrieb (+ Speicher row).
- [ ] S-6 Eingang (tabs, item deep links, in-place answers), Dateien (all), Artifacts
  (all, viewer outside shell) → unchanged.
- [ ] S-7 Unsaved-changes guards on every tab, subpage, Zugänge entry, MCP wizard and
  file editor → unchanged.
