import { createElement as h, useState } from "react";
import GroupLabel from "../../../../web/components/GroupLabel.jsx";
import ListCard from "../../../../web/components/ListCard.jsx";
import ListRow, {
  CheckboxRow,
  NumberRow,
  RadioRow,
  SelectRow,
  ToggleRow,
  unknownValue,
} from "../../../../web/components/ListRow.jsx";
import ReferenceRow from "../../../../web/components/ReferenceRow.jsx";
import Segmented from "../../../../web/components/Segmented.jsx";

export default function ListFixture() {
  const [events, setEvents] = useState([]);
  const [memory, setMemory] = useState(false);
  const [members, setMembers] = useState(4);
  const [language, setLanguage] = useState("de");
  const [shell, setShell] = useState("off");
  const [server, setServer] = useState(false);
  const [segment, setSegment] = useState("active");
  const record = (entry) => setEvents((list) => [...list, entry]);
  return h(
    "main",
    { className: "harness" },
    h(
      "section",
      null,
      h(
        GroupLabel,
        {
          hint: "Erinnerungen laufen auch ohne geöffnete App.",
          action: {
            label: "+ Erinnerung erstellen",
            onClick: () => record("action:reminder"),
          },
        },
        "Gedächtnis & Erinnerungen",
      ),
      h(
        ListCard,
        { label: "Gedächtnis & Erinnerungen" },
        h(ToggleRow, {
          label: "Gedächtnis",
          hint: "Speichert Notizen zwischen Unterhaltungen.",
          checked: memory,
          onChange: (value) => {
            setMemory(value);
            record(`memory:${value}`);
          },
        }),
        h(ListRow, {
          label: "Gespeicherte Notizen",
          value: "12",
          onClick: () => record("open:notes"),
        }),
        h(ListRow, { label: "Letzte Diagnose", value: unknownValue }),
        h(ListRow, {
          label: "Telegram",
          sub: "Bot @home",
          status: { tone: "ok", text: "Verbunden" },
        }),
        h(ListRow, {
          label: "Updates",
          status: { tone: "warn", text: "1.29.0 verfügbar" },
        }),
        h(ListRow, {
          label: "Plugin",
          sub: "Version 2.1",
          menu: { onClick: () => record("menu:plugin") },
        }),
        h(ListRow, {
          label: "ls",
          onDelete: () => record("delete:ls"),
          deleteLabel: "ls entfernen",
        }),
        h(NumberRow, {
          label: "Max. Mitglieder",
          value: members,
          min: 1,
          max: 8,
          onChange: (value) => {
            setMembers(value);
            record(`members:${value}`);
          },
        }),
        h(SelectRow, {
          label: "Sprache der Hinweise",
          value: language,
          options: [
            { value: "de", label: "Deutsch" },
            { value: "en", label: "Englisch" },
          ],
          onChange: (value) => {
            setLanguage(value);
            record(`language:${value}`);
          },
        }),
      ),
      h(
        ListCard,
        { label: "Shell" },
        ...["off", "approval", "full"].map((value) =>
          h(RadioRow, {
            key: value,
            name: "shell",
            value,
            label: { off: "Aus", approval: "Mit Freigabe", full: "Voll" }[value],
            checked: shell === value,
            onChange: (next) => {
              setShell(next);
              record(`shell:${next}`);
            },
          }),
        ),
      ),
      h(
        ListCard,
        { label: "MCP-Server" },
        h(CheckboxRow, {
          label: "GitHub",
          sub: "https://api.github.com/mcp",
          pill: "stdio",
          checked: server,
          onChange: (value) => {
            setServer(value);
            record(`server:${value}`);
          },
        }),
      ),
      h(ReferenceRow, {
        title: "Suchanbieter",
        href: "/connections?section=services&item=web-search",
        onOpen: () => record("accounts:services/web-search"),
      }),
      h(ReferenceRow, {
        title: "Sprachdienst",
        onOpen: () => record("accounts:services/speech"),
      }),
      h(
        ListCard,
        { label: "Gesperrt" },
        h(ListRow, { label: "Gesperrter Link", href: "#blocked", disabled: true }),
      ),
      h(Segmented, {
        label: "Ansicht",
        options: [
          { value: "active", label: "Aktiv" },
          { value: "archive", label: "Archiv" },
        ],
        value: segment,
        onChange: (value) => {
          setSegment(value);
          record(`segment:${value}`);
        },
      }),
    ),
    h("output", { "data-testid": "log" }, events.join(" ")),
  );
}
