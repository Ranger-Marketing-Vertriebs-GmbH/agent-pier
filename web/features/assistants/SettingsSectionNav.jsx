import React, { useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// While a chip click scrolls smoothly, intermediate sections must not steal the state.
const clickHold = 900;
// Jump links for the long settings page; only shown on narrow screens. The chip of the
// topmost section in view is marked as the current location.
export default function SettingsSectionNav({ assistant, personal }) {
  const sections = [
    ["profile", "agent-profile"],
    ["shell", "agent-shell"],
    ...(personal ? [["access", "agent-access"]] : []),
    ...(personal && Array.isArray(assistant.mcpServers) ? [["mcp", "agent-mcp"]] : []),
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
  const ids = sections.map(([, id]) => id).join(" ");
  const [active, setActive] = useState("agent-profile");
  const nav = useRef(null);
  const held = useRef(0);
  useEffect(() => {
    const scroll = nav.current?.closest(".assistant-settings-scroll");
    const root =
      scroll && getComputedStyle(scroll).overflowY !== "visible" ? scroll : null;
    const targets = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!targets.length || typeof IntersectionObserver !== "function") return;
    const visible = new Set();
    // A short last section never reaches the band, so the scroll end selects it.
    const edge = root || document.scrollingElement;
    const update = () => {
      if (Date.now() < held.current) return;
      const atEnd =
        edge &&
        edge.scrollTop > 0 &&
        edge.scrollTop + edge.clientHeight >= edge.scrollHeight - 2;
      // The shell section sits inside the profile form: the innermost visible one wins.
      const first = targets.find(
        (target) =>
          visible.has(target.id) &&
          !targets.some(
            (inner) =>
              inner !== target && visible.has(inner.id) && target.contains(inner),
          ),
      );
      if (atEnd) setActive(targets[targets.length - 1].id);
      else if (first) setActive(first.id);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        update();
      },
      // The band below the sticky chip row decides which section is current; it starts 2px
      // below the scroll offset so a section that merely touches the edge does not count.
      { root, rootMargin: "-58px 0px -55% 0px" },
    );
    targets.forEach((target) => observer.observe(target));
    const listened = root || window;
    listened.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      listened.removeEventListener("scroll", update);
    };
  }, [ids]);
  useEffect(() => {
    const row = nav.current;
    const chip = row?.querySelector(`a[href="#${active}"]`);
    if (!chip) return;
    if (
      chip.offsetLeft < row.scrollLeft ||
      chip.offsetLeft + chip.offsetWidth > row.scrollLeft + row.clientWidth
    )
      row.scrollLeft = Math.max(0, chip.offsetLeft - 12);
  }, [active]);
  return (
    <nav ref={nav} className="assistant-section-nav" aria-label={copy.settingsSections}>
      {sections.map(([key, id]) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={active === id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            const target = document.getElementById(id);
            if (!target) return;
            held.current = Date.now() + clickHold;
            setActive(id);
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
