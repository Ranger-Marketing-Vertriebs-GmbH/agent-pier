import React, { useId } from "react";
import Icon from "../../components/Icon.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";

export default function SshResourceList({
  items,
  tab,
  selectedId,
  select,
  ownerName,
  accesses,
  rowRefs,
}) {
  const idPrefix = useId();
  const isAccess = tab === "accesses";
  return (
    <div className="ssh-resource-list">
      <div className="ssh-list-columns" aria-hidden="true">
        <span>{isAccess ? copy.nameConnection : copy.name}</span>
        <span>{projectCopy.project}</span>
        <span>{isAccess ? copy.keyMode : copy.keyInUse}</span>
      </div>
      <ul aria-label={isAccess ? copy.accessesTab : copy.keysTab}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              ref={(node) => {
                if (node) rowRefs.current.set(item.id, node);
                else rowRefs.current.delete(item.id);
              }}
              className={`ssh-resource-row${selectedId === item.id ? " selected" : ""}`}
              aria-label={item.name}
              aria-describedby={`${isAccess ? `${idPrefix}-${item.id}-endpoint ` : ""}${idPrefix}-${item.id}-owner ${idPrefix}-${item.id}-meta`}
              aria-expanded={selectedId === item.id}
              aria-controls={selectedId === item.id ? "ssh-details" : undefined}
              onClick={() => select(item.id)}
            >
              <span className="ssh-resource-name">
                <Icon name={isAccess ? "terminal" : "shield"} />
                <span>
                  <strong>{item.name}</strong>
                  {isAccess && (
                    <small id={`${idPrefix}-${item.id}-endpoint`}>
                      {item.username}@{item.host}
                      {item.port !== 22 ? `:${item.port}` : ""}
                    </small>
                  )}
                </span>
              </span>
              <span className="ssh-resource-owner" id={`${idPrefix}-${item.id}-owner`}>
                <span className="ssh-owner-badge">{ownerName(item)}</span>
              </span>
              <span className="ssh-resource-meta" id={`${idPrefix}-${item.id}-meta`}>
                {isAccess
                  ? item.keyName
                  : accesses === null
                    ? copy.usageUnavailable
                    : copy.accessCount(
                        accesses.filter((access) => access.keyId === item.id).length,
                      )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
