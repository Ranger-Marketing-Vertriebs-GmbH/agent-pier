import { createElement as h, useState } from "react";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";
import RunStatusFilter from "../../../../web/features/pipelines/RunStatusFilter.jsx";

const entries = [
  ["profile", "Profil"],
  ["capabilities", "Fähigkeiten", 3],
  ["work", "Arbeit"],
  ["telegram", "Telegram"],
  ["reminders", "Erinnerungen", 12],
  ["notifications", "Benachrichtigungen"],
];
const counts = {
  "awaiting-human": 1,
  running: 2,
  failed: 3,
  completed: 12,
  cancelled: 4,
};

export default function TabsFixture() {
  const [selected, setSelected] = useState("profile");
  const [status, setStatus] = useState("");
  const tabs = entries.map(([id, label, count]) => ({
    id,
    label,
    ...(count === undefined ? {} : { count }),
  }));
  return h(
    "main",
    { className: "harness" },
    h(
      "section",
      { className: "harness-narrow" },
      h(UnderlineTabs, {
        label: "Harness tabs",
        tabs,
        selected,
        onSelect: setSelected,
        idPrefix: "harness",
      }),
    ),
    h("p", { "data-testid": "selected" }, selected),
    h(
      "section",
      { className: "harness-narrow" },
      h(RunStatusFilter, { counts, selected: status, onSelect: setStatus }),
    ),
  );
}
