import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// Jump links for the long settings page; only shown on narrow screens.
export default function SettingsSectionNav({ assistant, personal }) {
  const sections = [
    ["profile", "agent-profile"],
    ...(personal ? [["access", "agent-access"]] : []),
    ...(personal && assistant.capabilities?.memory ? [["memory", "agent-memory"]] : []),
    ...(personal && assistant.capabilities?.reminders
      ? [
          ["reminders", "agent-reminders"],
          ["routines", "agent-routines"],
        ]
      : []),
    ...(!assistant.teamMemberId ? [["team", "agent-team"]] : []),
    ...(!assistant.teamMemberId || personal ? [["telegram", "agent-telegram"]] : []),
  ];
  return (
    <nav className="assistant-section-nav" aria-label={copy.settingsSections}>
      {sections.map(([key, id]) => (
        <a
          key={id}
          href={`#${id}`}
          onClick={(event) => {
            event.preventDefault();
            const target = document.getElementById(id);
            if (!target) return;
            const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
            const heading = target.querySelector("h1, h2, h3") || target;
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }}
        >
          {copy.sections[key]}
        </a>
      ))}
    </nav>
  );
}
