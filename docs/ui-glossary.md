# UI glossary

These terms keep AgentPier's interface copy consistent in German and English. They
apply to the web catalogs (`web/lib/i18n/de/`, `web/lib/i18n/en/`) and to the
backend messages that reach the browser (`server/lib/i18n/`). Native CLI output,
diagnostic evidence, code identifiers, URLs and anchors keep their original wording.

`tests/unit/i18n-terminology.test.js` checks the rules marked _(checked)_.

## Terms

| Concept                                | German                                   | English            | Notes                                                                                                   |
| -------------------------------------- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| A running or stored CLI terminal       | die Session, die Sessions                | session            | Never "Sitzung" _(checked)_. Compounds take a hyphen: "Session-ID", "Shell-Session", "Coding-Session".  |
| The Accounts page and its entries      | Accounts, der Account                    | Accounts, account  | Never "Konten" or "Zugänge →" for the page _(checked)_. A vendor's own account stays "Konto".           |
| A program or capability an agent calls | das Tool, die Tools                      | tool               | Never "Werkzeug" _(checked)_. "SSH-Tools", "Web-Tools", "AgentPier-Tools".                              |
| A stored connection or credential      | der Zugang (Provider-Zugang, SSH-Zugang) | connection, access | Not "Verbindung" for provider connections _(checked)_.                                                  |
| A permission level                     | die Berechtigung                         | permission         | For example a launch mode or a tool's permission profile.                                               |
| The approval of a single request       | die Freigabe                             | approval           | Approve or deny one action; not a stored setting.                                                       |
| Project knowledge (memory)             | das Projektwissen                        | memory             | German copy does not use "Memory" on its own.                                                           |
| An Agency agent an agent starts from   | die Vorlage                              | template           | "Mit Vorlage beginnen" / "Start from a template"; the catalog stays "Agency-Agenten" / "Agency agents". |
| `{agent.workspace}` in an MCP setting  | der Agenten-Platzhalter                  | agent placeholder  | Resolves to each bound agent's own folder; the overview card is "Agentenordner" / "Agent folders".      |

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

- **Navigation paths** use "›" with spaces: "Accounts › MCP-Server",
  "Einstellungen › Zugriff › GitHub-Zugänge" _(checked)_.
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
