import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow } from "../../../components/ListRow.jsx";
import { useCrossLink } from "../../../app/cross-link.js";
import { assistantSecretsCopy as copy } from "../../../lib/i18n/messages/assistant-secrets.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { toggleId } from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";
// The search, loading and empty states look like the SSH page's.
import "./ssh-grant-page.css";

/**
 * The secrets this agent receives in `.agentpier/secrets.env`; part of the Work draft.
 * `secrets` is undefined while loading and null when the catalog could not be read.
 * `locked`: an agent with its own Telegram bot for other people gets none.
 */
export default function SecretGrantPage({
  secrets,
  selected,
  disabled,
  locked = false,
  onChange,
  onRetry,
  onBack,
  navigate,
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const settings = useCrossLink()({ view: "settings", settingsSection: "secrets" });
  const needle = query.trim().toLowerCase();
  const shown = (secrets || []).filter(
    (s) =>
      !needle ||
      [s.name, s.description, s.projectName].some((v) =>
        v?.toLowerCase().includes(needle),
      ),
  );
  return (
    <section className="agent-subpage" aria-label={copy.title}>
      <SubpageHeader title={copy.title} tab="work" onBack={onBack} />
      <p className="assistant-note">{copy.intro}</p>
      {locked && (
        <p className="agent-locked-notice" role="note">
          <Icon name="shield" size={16} />
          <span>{copy.telegramSenders}</span>
        </p>
      )}
      {secrets === null && (
        <div className="ssh-grant-state">
          <ErrorMessage error={copy.loadError} />
          <button type="button" className="button secondary" onClick={onRetry}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {secrets === undefined && (
        <ul className="ssh-grant-skeleton" aria-label={copy.loading}>
          {[0, 1, 2].map((n) => (
            <li key={n} />
          ))}
        </ul>
      )}
      {secrets?.length === 0 && (
        <div className="ssh-grant-state">
          <p>{copy.empty}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => navigate(settings)}
          >
            {copy.manage}
          </button>
        </div>
      )}
      {secrets?.length > 0 && (
        <>
          <label className="ssh-grant-search" htmlFor={searchId}>
            {copy.search}
          </label>
          <input
            id={searchId}
            className="ssh-grant-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {!shown.length && <p className="assistant-note">{copy.noMatch}</p>}
          <ListCard label={copy.title}>
            {shown.map((s) => (
              <CheckboxRow
                key={s.id}
                label={s.name}
                sub={[
                  s.description,
                  s.projectId ? copy.project(s.projectName || s.projectId) : copy.global,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                checked={selected.includes(s.id)}
                disabled={disabled || (locked && !selected.includes(s.id))}
                onChange={(on) => onChange(toggleId(selected, s.id, on))}
              />
            ))}
          </ListCard>
        </>
      )}
    </section>
  );
}
