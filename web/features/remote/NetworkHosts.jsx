import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { remoteCopy as copy } from "../../lib/i18n/messages/remote.js";
import { networkHost } from "../../../server/lib/network-host.js";

/**
 * Network mode's extra hosts: one row each with its remove button, and a field that
 * adds a host after the server's own check, so a wrong host is named before saving.
 */
export default function NetworkHosts({ hosts, onChange, disabled }) {
  const id = useId();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const add = () => {
    const text = input.trim();
    if (!text) return;
    const host = networkHost(text);
    if (!host) return setError(copy.invalidHost(text));
    setError("");
    setInput("");
    if (!hosts.includes(host)) onChange([...hosts, host]);
  };
  return (
    <>
      <GroupLabel as="h3" id={`${id}-label`}>
        {copy.hosts}
      </GroupLabel>
      <p className="field-description">{copy.hostsDescription}</p>
      {hosts.length > 0 && (
        <ListCard labelledBy={`${id}-label`}>
          {hosts.map((host) => (
            <ListRow
              key={host}
              label={host}
              disabled={disabled}
              deleteLabel={copy.removeHost(host)}
              onDelete={() => onChange(hosts.filter((item) => item !== host))}
            />
          ))}
        </ListCard>
      )}
      <div className="remote-form-row">
        <input
          type="text"
          aria-label={copy.hostInput}
          value={input}
          disabled={disabled}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button
          type="button"
          className="button secondary"
          disabled={disabled}
          onClick={add}
        >
          {copy.addHost}
        </button>
      </div>
      <ErrorMessage id={`${id}-error`} error={error} />
    </>
  );
}
