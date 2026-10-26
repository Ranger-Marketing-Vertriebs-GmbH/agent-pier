# UI glossary

These terms keep AgentPier's interface copy consistent in German and English. They
apply to the web catalogs (`web/lib/i18n/de/`, `web/lib/i18n/en/`) and to the
backend messages that reach the browser (`server/lib/i18n/`). Native CLI output,
diagnostic evidence, code identifiers, URLs and anchors keep their original wording.

`tests/unit/i18n-terminology.test.js` checks the rules marked _(checked)_.

## Terms

| Concept                                | German                                   | English            | Notes                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A running or stored CLI terminal       | die Session, die Sessions                | session            | Never "Sitzung" _(checked)_. Compounds take a hyphen: "Session-ID", "Shell-Session", "Coding-Session".                                                                         |
| A native CLI sign-in and its tab       | Accounts, der Account                    | Accounts, account  | Never "Konten" _(checked)_. The tab is CLIs & Erweiterungen › Accounts. A vendor's own account stays "Konto".                                                                  |
| A program or capability an agent calls | das Tool, die Tools                      | tool               | Never "Werkzeug" _(checked)_. "SSH-Tools", "Web-Tools", "AgentPier-Tools".                                                                                                     |
| A stored connection or credential      | der Zugang (Provider-Zugang, SSH-Zugang) | connection, access | Not "Verbindung" for provider connections _(checked)_.                                                                                                                         |
| The area for shared credentials        | Zugänge                                  | Connections        | Menu area (`/connections`): Modell-Zugänge, Dienste für Agenten, MCP-Server, SSH/SFTP-Zugänge, Geheimnisse, GitHub-Zugänge. Never "Verbindungen"; no "→" in paths _(checked)_. |
| Who uses an entry                      | Benutzt von                              | Used by            | The list on every entry in Zugänge and on native CLI accounts.                                                                                                                 |
| What an agent may use (agent tab)      | Zugriffe                                 | Access             | The agent settings tab with projects, SSH/SFTP, MCP servers, pipelines, GitHub and secrets.                                                                                    |
| CLI agent definitions (Agency)         | Unteragenten                             | Subagents          | CLIs & Erweiterungen › Erweiterungen › Unteragenten; never "Agenten" for them.                                                                                                 |
| A permission level                     | die Berechtigung                         | permission         | For example a launch mode or a tool's permission profile.                                                                                                                      |
| The approval of a single request       | die Freigabe                             | approval           | Approve or deny one action; not a stored setting.                                                                                                                              |
| Project knowledge (memory)             | das Projektwissen                        | memory             | German copy does not use "Memory" on its own.                                                                                                                                  |
| An Agency agent an agent starts from   | die Vorlage                              | template           | "Aus Vorlage" / "From template"; the tab is Agenten › Vorlagen / Agents › Templates; the catalog stays "Agency-Agenten" / "Agency agents".                                     |
| `{agent.workspace}` in an MCP setting  | der Agenten-Platzhalter                  | agent placeholder  | Resolves to each bound agent's own folder; the overview card is "Agentenordner" / "Agent folders".                                                                             |

## Navigation and areas

The sidebar holds agents and sessions; every other area is in the **Menü** popover
([ADR 0005](adr/0005-navigation-information-architecture.md)).

| Concept                           | German                                                                           | English                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Menu button and popover           | Menü                                                                             | Menu                                                                           |
| Menu group: doing work            | Arbeiten                                                                         | Work                                                                           |
| Menu group: configuring           | Einrichten                                                                       | Set up                                                                         |
| Areas in Arbeiten / Work          | Übersicht · Projekte · Pipelines · Dateien · Artifacts                           | Overview · Projects · Pipelines · Files · Artifacts                            |
| Areas in Einrichten / Set up      | Agenten · CLIs & Erweiterungen · Zugänge · Einstellungen                         | Agents · CLIs and extensions · Connections · Settings                          |
| Agents page tabs                  | Alle Agenten · Teams · Vorlagen · Laufzeit                                       | All agents · Teams · Templates · Runtime                                       |
| Agent settings tabs               | Überblick · Identität · Fähigkeiten · Zugriffe · Team · Automatisierung · Kanäle | Overview · Identity · Capabilities · Access · Team · Automation · Channels     |
| Section in the Access tab         | Wer diesen Agenten nutzt                                                         | Who uses this agent                                                            |
| CLIs and extensions tabs          | Installation · Accounts · Erweiterungen · AgentPier als MCP                      | Installation · Accounts · Extensions · AgentPier as MCP                        |
| Settings tabs                     | Allgemein · App & Benachrichtigungen · Benutzer · Fernzugriff · Betrieb          | General · App and notifications · Users · Remote access · Operations           |
| Wizard capability profiles (risk) | Gesprächspartner · Rechercheur · Assistent · Operator (gering / mittel / hoch)   | Conversation partner · Researcher · Assistant · Operator (low / medium / high) |
| Search                            | Suchen (⌘K)                                                                      | Search (⌘K)                                                                    |

Old names (Accounts as a page, Erweiterungen › Agenten, Einstellungen › Zugriff,
Arbeitsbereich, Agentendienst as a settings page, the agent tabs Profil, Arbeit,
Routinen & Check-ins and Telegram) are no longer used in copy; the search keeps them as
aliases so they still find the new place.

## Users and their agents

Restricted users ([Users](users.md)) bring their own terms. "Benutzer" in German copy
always means such a person, never the operating-system user or the owner.

| Concept                                            | German                     | English              | Notes                                                               |
| -------------------------------------------------- | -------------------------- | -------------------- | ------------------------------------------------------------------- |
| The person who set up AgentPier                    | der Besitzer               | owner                | Copy addressed to him says "du" / "you".                            |
| A person the owner adds to chat with agents        | der Benutzer, die Benutzer | user                 | Not "Nutzer", "Mitglied" or "Konto".                                |
| An agent that serves one user                      | Eigener Agent              | Own agent            | Its memory, files and browser are hers.                             |
| An agent that serves several users                 | Geteilter Agent            | Shared agent         | Shares memory, profile and browser; each user's chats stay private. |
| Both kinds together, in the owner's lists          | Agenten von Benutzern      | Agents of users      | Section title on the agents page and in the sidebar.                |
| Level: chat, attach, dictate                       | Nur chatten                | Chat only            |                                                                     |
| Level: also name, picture, instructions, reminders | Personalisieren            | Personalize          |                                                                     |
| Level: also released capabilities and Telegram     | Erweitert                  | Extended             |                                                                     |
| The opt-in that lets the owner read a user's chats | Besitzer darf Chats lesen  | Owner may read chats | Counts from its start; always visible to the user.                  |
| The chat reminders and Telegram deliver into       | Hauptchat                  | Main chat            | Renamed only, never archived or deleted.                            |

## Actions

Use one verb per concept, in both languages:

| Verb               | German     | English | Meaning                                                          |
| ------------------ | ---------- | ------- | ---------------------------------------------------------------- |
| Permanent loss     | Löschen    | Delete  | The data is gone: a backup, a key, a version, an artifact.       |
| Detach a reference | Entfernen  | Remove  | The thing still exists elsewhere: a favorite, a grant, an entry. |
| End access         | Widerrufen | Revoke  | A client or session loses access it was given.                   |
| Drop a draft       | Verwerfen  | Discard | Unsaved input is thrown away.                                    |

A confirm button repeats the verb of the button that opened it, for example
**Delete** → **Delete now**, **Remove** → **Remove now**, **Revoke access** →
**Revoke now**, **Reset browser profile** → **Reset profile**.

Shared labels — Cancel, Save, Delete, Remove, Retry ("Try again"), Close, Back,
Discard — come from `commonCopy` (`web/lib/i18n/messages/common.js`). A feature
catalog defines its own key only when its text differs from the shared one.

## Writing rules

- **Navigation paths** use "›" with spaces: "Zugänge › MCP-Server",
  "Agenten › Laufzeit › Erweitert", "Settings › App and notifications" _(checked)_.
- **Ellipses** take a space before them in both languages: "Wird geladen …",
  "Loading …" _(checked)_. Shortened values such as `3f2a9c1e…b6c5` and syntax such as
  `${…}` or `<U+…>` keep their form.
- **English sentence case** for labels, buttons and titles: "Override and continue",
  "Empty trash", "Open settings" _(checked)_. Proper nouns keep their capitals
  (Telegram, GitHub App, Claude Code, Brave Search); the test lists them.
- **Copy buttons** name what they copy: "Copy command: Add", "Copy configuration: Add",
  "HTTPS-MCP-Adresse kopieren".
- **Calls to action** do what they say. A button labelled "Add SSH key" opens the
  key form, not just the tab that holds it.
