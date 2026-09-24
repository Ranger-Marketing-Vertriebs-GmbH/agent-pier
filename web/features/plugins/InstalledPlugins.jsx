import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import { Pagination } from "../../components/Pagination.jsx";
import ExtensionTable from "../extensions/ExtensionTable.jsx";
export default function InstalledPlugins({
  installed,
  installedQuery,
  installedPages,
  capabilities,
  disabled,
  mutate,
  setConfirm,
}) {
  return (
    <>
      <ExtensionTable
        heads={[hub.headPlugin, hub.headSource, hub.headVersion]}
        empty={installedQuery ? copy.extensionEmpty : commonCopy.noInstalledPlugins}
        rows={(installed.length ? installedPages.items : []).map((p, index) => ({
          key: `${p.id}-${index}`,
          name: p.name,
          sub: p.description,
          details: p.path && <code className="extension-path">{p.path}</code>,
          tag: [p.scope, p.marketplace].filter(Boolean).join(" · "),
          status: {
            on: p.enabled !== false,
            text:
              (p.version || copy.extensionScope) +
              (p.enabled === false
                ? commonCopy.disabledSuffix
                : p.enabled === true
                  ? commonCopy.enabledSuffix
                  : ""),
          },
          actions: p.removable !== false && (
            <>
              {capabilities.enable && (
                <button
                  className="button secondary compact"
                  disabled={disabled}
                  aria-label={commonCopy.togglePluginLabel(
                    p.name,
                    p.enabled === false
                      ? commonCopy.enableAction
                      : commonCopy.disableAction,
                  )}
                  onClick={() =>
                    mutate(
                      {
                        action: p.enabled === false ? "enable" : "disable",
                        pluginId: p.id,
                      },
                      copy.toggleNotice(
                        p.name,
                        p.enabled === false
                          ? commonCopy.enabledResult
                          : commonCopy.disabledResult,
                      ),
                    )
                  }
                >
                  {p.enabled === false ? commonCopy.enable : commonCopy.disable}
                </button>
              )}
              {capabilities.update && (
                <button
                  className="button secondary compact"
                  disabled={disabled}
                  aria-label={commonCopy.updatePluginLabel(p.name)}
                  onClick={() =>
                    mutate(
                      { action: "update", pluginId: p.id },
                      copy.updatedNotice(p.name),
                    )
                  }
                >
                  {commonCopy.refresh}
                </button>
              )}
              <button
                className="button secondary compact"
                disabled={disabled}
                aria-label={commonCopy.removePluginLabel(p.name)}
                onClick={() =>
                  setConfirm({
                    action: "remove",
                    name: p.name,
                    body: { action: "remove", pluginId: p.id },
                  })
                }
              >
                {commonCopy.remove}
              </button>
            </>
          ),
        }))}
      />
      <Pagination paging={installedPages} label={copy.installedPluginsHeading} />
    </>
  );
}
