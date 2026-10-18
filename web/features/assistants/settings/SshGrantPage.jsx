import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { CheckboxRow, RadioRow } from "../../../components/ListRow.jsx";
import { useCrossLink } from "../../../app/cross-link.js";
import { assistantSshCopy as copy } from "../../../lib/i18n/messages/assistant-ssh.js";
import { setSshGrant, sshModes } from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import "./ssh-grant-page.css";

/**
 * The SSH hosts this agent may use, each with its mode; part of the Work draft.
 * `hosts` is undefined while loading and null when the catalog could not be read.
 */
export default function SshGrantPage({
  hosts,
  grants,
  disabled,
  onChange,
  onRetry,
  onBack,
  navigate,
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const settings = useCrossLink()({ view: "settings", settingsSection: "ssh" });
  const modeOf = new Map(grants.map((g) => [g.accessId, g.mode]));
  const removed = hosts
    ? grants.filter((g) => !hosts.some((h) => h.id === g.accessId))
    : [];
  const needle = query.trim().toLowerCase();
  const shown = (hosts || []).filter(
    (h) =>
      !needle ||
      [h.name, h.host, h.username, h.projectName].some((v) =>
        v?.toLowerCase().includes(needle),
      ),
  );
  return (
    <section className="agent-subpage ssh-grant-page" aria-label={copy.title}>
      <SubpageHeader title={copy.title} tab="work" onBack={onBack} />
      <p className="assistant-note">{copy.intro}</p>
      {hosts === null && (
        <div className="ssh-grant-state">
          <ErrorMessage error={copy.loadError} />
          <button type="button" className="button secondary" onClick={onRetry}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {hosts === undefined && (
        <ul className="ssh-grant-skeleton" aria-label={copy.loading}>
          {[0, 1, 2].map((n) => (
            <li key={n} />
          ))}
        </ul>
      )}
      {hosts?.length === 0 && (
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
      {hosts?.length > 0 && (
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
            {shown.map((h) => {
              const mode = modeOf.get(h.id);
              return (
                <div key={h.id} className="ssh-grant-host">
                  <CheckboxRow
                    label={h.name}
                    sub={[
                      copy.endpoint(h.username, h.host, h.port),
                      h.projectName ? copy.project(h.projectName) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    checked={!!mode}
                    disabled={disabled}
                    onChange={(on) =>
                      onChange(setSshGrant(grants, h.id, on ? "approval" : null))
                    }
                  />
                  {mode && (
                    <div className="ssh-grant-modes">
                      <GroupLabel as="h3" id={`ssh-mode-${h.id}-label`}>
                        {copy.modeLegend}
                      </GroupLabel>
                      <ListCard labelledBy={`ssh-mode-${h.id}-label`} disabled={disabled}>
                        {sshModes.map((m) => (
                          <RadioRow
                            key={m}
                            name={`ssh-mode-${h.id}`}
                            value={m}
                            label={copy.modes[m]}
                            sub={copy.modeHints[m]}
                            checked={mode === m}
                            disabled={disabled}
                            onChange={(value) =>
                              onChange(setSshGrant(grants, h.id, value))
                            }
                          />
                        ))}
                      </ListCard>
                      {mode !== "approval" && (
                        <p className="ssh-grant-warning">{copy.trustedWarning}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </ListCard>
        </>
      )}
      {removed.length > 0 && (
        <ListCard label={copy.removed}>
          {removed.map((g) => (
            <div key={g.accessId} className="ssh-grant-removed" aria-disabled="true">
              <strong>{copy.removed}</strong>
              <small>{copy.removedHint}</small>
            </div>
          ))}
        </ListCard>
      )}
    </section>
  );
}
