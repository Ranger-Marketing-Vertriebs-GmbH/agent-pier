import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { assistantSkillsCopy as copy } from "../../../lib/i18n/messages/assistant-skills.js";
import { assistantApi } from "../assistant-api.js";
import { toggleId } from "./agent-settings-fields.js";
import { skillFilters, skillLocked, statusText, visibleSkills } from "./skill-list.js";
import SubpageHeader from "./SubpageHeader.jsx";
import "../agent-skills.css";

function SkillDetails({ skill, shellOff, on }) {
  const tone = skill.state === "ready" ? "ok" : "warn";
  return (
    <>
      {skill.description && (
        <span className="agent-skill-line" lang="en">
          {skill.description}
        </span>
      )}
      <span className={`agent-skill-line agent-skill-state ${tone}`}>
        {statusText(skill, copy)}
      </span>
      {skill.usesShell && shellOff && (
        <span className="agent-skill-line agent-skill-shell">{copy.needsShell}</span>
      )}
      {on && skill.assigned && skill.state === "ready" && !skill.active && (
        <span className="agent-skill-line">{copy.pending}</span>
      )}
      {skill.risk && (
        <span className="agent-skill-line agent-skill-risk" role="note">
          {copy.risks[skill.risk]}
        </span>
      )}
    </>
  );
}

/**
 * The bundled OpenClaw skills of one agent with their status on the running agent
 * service. Switches edit the Capabilities draft; the tab's save bar stores them.
 */
export default function SkillsPage({ assistant, draft, onBack }) {
  const [catalog, setCatalog] = useState(null),
    [error, setError] = useState(""),
    [term, setTerm] = useState(""),
    [filter, setFilter] = useState("all");
  const assistantId = assistant.id;
  useEffect(() => {
    let live = true;
    setError("");
    assistantApi
      .skills(assistantId)
      .then((next) => live && setCatalog(next))
      .catch((e) => live && setError(e.status === 503 ? copy.unavailable : e.message));
    return () => {
      live = false;
    };
  }, [assistantId, assistant.revision]);
  const on = draft.values.skills;
  const shellOff = draft.values.shell === "off";
  // Without the agent service the switched-on skills can still be switched off.
  const offline = Boolean(error) && !catalog;
  const skills = catalog
    ? visibleSkills(catalog.skills || [], { filter, term, on })
    : offline
      ? visibleSkills(
          // The saved ones, so a switch stays in place once it is turned off.
          [...new Set([...(draft.base.skills || []), ...on])]
            .sort()
            .map((name) => ({ name, description: "", state: "offline", missing: {} })),
          { term },
        )
      : [];
  return (
    <section id="agent-skills-page" className="agent-subpage" aria-label={copy.title}>
      <SubpageHeader
        title={copy.title}
        tab="capabilities"
        onBack={onBack}
        hint={copy.pageHint}
      />
      {shellOff && <p className="assistant-note">{copy.shellOff}</p>}
      <div className="agent-skills-toolbar">
        <label className="agent-skills-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={term}
            maxLength={100}
            placeholder={copy.search}
            aria-label={copy.search}
            onChange={(event) => setTerm(event.target.value)}
          />
        </label>
        <label className="agent-skills-filter">
          <select
            value={filter}
            aria-label={copy.filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {skillFilters.map((value) => (
              <option key={value} value={value}>
                {copy.filters[value]}
              </option>
            ))}
          </select>
          <Icon name="down" size={14} />
        </label>
      </div>
      <ErrorMessage error={error} />
      {!catalog && !error && <p className="assistant-note">{copy.loading}</p>}
      {catalog && !skills.length && <p className="assistant-note">{copy.empty}</p>}
      {offline && skills.length > 0 && (
        <p className="assistant-note">{copy.offlineHint}</p>
      )}
      {skills.length > 0 && (
        <ListCard label={copy.title} className="agent-skills-list">
          {skills.map((skill) => {
            const checked = on.includes(skill.name);
            return (
              <ToggleRow
                key={skill.name}
                label={
                  skill.emoji ? (
                    <>
                      <span aria-hidden="true">{skill.emoji} </span>
                      {skill.name}
                    </>
                  ) : (
                    skill.name
                  )
                }
                sub={
                  offline ? undefined : (
                    <SkillDetails skill={skill} shellOff={shellOff} on={checked} />
                  )
                }
                checked={checked}
                disabled={
                  draft.saving || skillLocked(skill, checked) || (offline && !checked)
                }
                onChange={(next) => draft.set("skills", toggleId(on, skill.name, next))}
              />
            );
          })}
        </ListCard>
      )}
    </section>
  );
}
