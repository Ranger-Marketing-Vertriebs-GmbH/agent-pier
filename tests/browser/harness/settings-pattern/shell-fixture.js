/* global location */
import { createElement as h, useState } from "react";
import SettingsShell from "../../../../web/components/SettingsShell.jsx";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";

export default function ShellFixture() {
  const query = new URLSearchParams(location.search);
  const [log, setLog] = useState("");
  const [tab, setTab] = useState("workspace");
  return h(
    SettingsShell,
    {
      title: "Einstellungen",
      subtitle: "Lokal gespeichert",
      description: "Arbeitsbereich, Zugriff und Betrieb",
      leading: query.get("leading") || "menu",
      onLeading: () => setLog(query.get("leading") || "menu"),
      actions: h("button", { type: "button", className: "button secondary" }, "Aktion"),
      tabs:
        query.get("tabs") === "0"
          ? null
          : h(UnderlineTabs, {
              label: "Einstellungen",
              tabs: [
                { id: "workspace", label: "Arbeitsbereich" },
                { id: "access", label: "Zugriff" },
                { id: "operations", label: "Betrieb" },
              ],
              selected: tab,
              onSelect: setTab,
              idPrefix: "shell",
            }),
    },
    h("p", null, "Inhalt"),
    h("output", { "data-testid": "log" }, log),
  );
}
