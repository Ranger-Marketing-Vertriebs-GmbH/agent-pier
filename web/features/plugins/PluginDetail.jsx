import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { pluginActions } from "./plugin-actions.js";
import { pluginStatus } from "./plugin-state.js";

// The plugin subpage: version, source, state, path and the immediate actions.
export default function PluginDetail({
  plugin,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onBack,
}) {
  const heading = useRef(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const status = pluginStatus(plugin);
  const actions = pluginActions(plugin, { capabilities, mutate, setConfirm });
  return (
    <div className="plugin-detail">
      <div className="plugin-detail-head">
        <button
          type="button"
          className="list-row-icon-button"
          aria-label={hub.backToPlugins}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <h3 ref={heading} tabIndex={-1}>
          {plugin.name}
        </h3>
      </div>
      {plugin.description && (
        <p className="plugin-detail-description">{plugin.description}</p>
      )}
      <ListCard label={plugin.name} className="extension-list">
        <ListRow label={hub.headVersion} value={plugin.version || copy.extensionScope} />
        <ListRow
          label={hub.headSource}
          value={
            [plugin.scope, plugin.marketplace].filter(Boolean).join(" · ") || unknownValue
          }
        />
        {status !== "unknown" && (
          <ListRow
            label={hub.headStatus}
            status={
              status === "enabled" ? { tone: "ok", text: hub.pluginActive } : undefined
            }
            value={status === "disabled" ? hub.pluginDisabled : undefined}
          />
        )}
        {plugin.path && (
          <ListRow
            label={hub.path}
            sub={<code className="extension-path">{plugin.path}</code>}
          />
        )}
      </ListCard>
      {actions.length > 0 && (
        <div className="plugin-detail-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`button ${action.danger ? "danger" : "secondary"}`}
              aria-label={action.ariaLabel}
              disabled={disabled}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
