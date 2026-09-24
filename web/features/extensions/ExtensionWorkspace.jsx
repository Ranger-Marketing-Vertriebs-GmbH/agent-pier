import React, { useCallback, useState } from "react";
import Icon from "../../components/Icon.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  mcpFormCopy,
} from "../../lib/i18n/messages/extensions.js";
import {
  marketplacesCopy,
  pluginCatalogCopy,
  profilePluginsCopy,
} from "../../lib/i18n/messages/plugins.js";
import { names } from "../../lib/providers.js";
import AgentsTab from "../agency/AgentsTab.jsx";
import MarketplacesTab from "../plugins/MarketplacesTab.jsx";
import PluginsTab from "../plugins/PluginsTab.jsx";
import PluginSourceForm from "../plugins/PluginSourceForm.jsx";
import useProfilePlugins from "../plugins/useProfilePlugins.js";
import McpForm from "./McpForm.jsx";
import McpTab from "./McpTab.jsx";
import SkillInstallForm from "./SkillInstallForm.jsx";
import SkillsTab from "./SkillsTab.jsx";
import useProfileExtensions from "./useProfileExtensions.js";

// One instance per profile (keyed by the page): the data hooks live here so
// switching tabs neither refetches nor drops notices, drafts or confirmations.
export default function ExtensionWorkspace({
  account,
  request,
  tab: requestedTab,
  onTab,
  busySetters,
  locked,
}) {
  const ext = useProfileExtensions({
    account,
    request,
    setParentBusy: busySetters.extensions,
  });
  const plugins = useProfilePlugins({
    account,
    request,
    setParentBusy: busySetters.plugins,
  });
  const [panel, setPanel] = useState(null);
  const [pluginMode, setPluginMode] = useState("installed");
  const [agentMode, setAgentMode] = useState("installed");
  const [agentCount, setAgentCount] = useState(undefined);
  const [agentsSeen, setAgentsSeen] = useState(false);
  // Keep the last known catalog support while a catalog account reloads.
  const [catalogSupported, setCatalogSupported] = useState(false);
  const supported = plugins.data
    ? Boolean(plugins.capabilities.marketplaces)
    : catalogSupported;
  if (supported !== catalogSupported) setCatalogSupported(supported);
  const tabs = [
    { id: "mcp", label: hub.tabMcp, count: ext.data?.mcp.servers.length },
    { id: "skills", label: hub.tabSkills, count: ext.data?.skills.items.length },
    { id: "plugins", label: hub.tabPlugins, count: plugins.data?.installed.length },
    ...(supported || (requestedTab === "marketplaces" && !plugins.data)
      ? [
          {
            id: "marketplaces",
            label: hub.tabMarketplaces,
            count: plugins.data?.marketplaces.length,
          },
        ]
      : []),
    ...(account.shared
      ? [{ id: "agents", label: hub.tabAgents, count: agentCount }]
      : []),
  ];
  const tab = tabs.some((item) => item.id === requestedTab) ? requestedTab : "mcp";
  if (tab === "agents" && !agentsSeen) setAgentsSeen(true);
  const openPanel = (kind) => {
    if (kind === "mcp" || kind === "skill") ext.setError("");
    setPanel(kind);
  };
  const closePanel = useCallback(() => setPanel(null), []);
  const subtitle = hub.panelSubtitle(account.name);
  const primary = {
    mcp: {
      label: mcpFormCopy.extensionAddSummary,
      run: () => openPanel("mcp"),
      disabled: !ext.data,
    },
    skills: {
      label: commonCopy.installSkill,
      run: () => openPanel("skill"),
      disabled: !ext.data,
    },
    plugins:
      account.tool === "opencode" && !supported
        ? {
            label: profilePluginsCopy.extensionInstallHeading,
            run: () => openPanel("npm"),
            disabled: !plugins.data || !plugins.capabilities.install,
          }
        : {
            label: pluginCatalogCopy.catalogHeading,
            run: () => setPluginMode("discover"),
            disabled: !supported,
          },
    marketplaces: {
      label: marketplacesCopy.addMarketplace,
      run: () => openPanel("market"),
      disabled: !plugins.data,
    },
    agents: { label: hub.browseCatalog, run: () => setAgentMode("catalog") },
  }[tab];
  const extPanel = panel === "mcp" || panel === "skill";
  const pluginPanel = panel === "market" || panel === "npm";
  const extProps = { ext, account, request, hideError: extPanel };
  return (
    <section className="extension-hub-card" aria-labelledby="extension-hub-profile">
      <header className="extension-hub-header">
        <div>
          <h2 id="extension-hub-profile">{account.name}</h2>
          <span>
            {names[account.tool] || account.tool}
            {ext.data?.mcp.path && (
              <>
                {" · "}
                <code>{ext.data.mcp.path}</code>
              </>
            )}
          </span>
        </div>
        <div className="extension-hub-primary">
          <button
            type="button"
            className="button primary"
            disabled={primary.disabled || locked}
            onClick={primary.run}
          >
            <Icon name="plus" size={16} />
            {primary.label}
          </button>
        </div>
      </header>
      <UnderlineTabs
        label={hub.tabs}
        tabs={tabs}
        selected={tab}
        onSelect={onTab}
        disabled={locked}
      />
      {tab !== "agents" && (
        <section
          role="tabpanel"
          id={`underline-tabpanel-${tab}`}
          aria-labelledby={`underline-tab-${tab}`}
          className="extension-tabpanel"
        >
          {tab === "mcp" && <McpTab {...extProps} />}
          {tab === "skills" && <SkillsTab {...extProps} />}
          {tab === "plugins" && (
            <PluginsTab
              plugins={plugins}
              account={account}
              mode={pluginMode}
              setMode={setPluginMode}
              catalogSupported={supported}
              hideError={pluginPanel}
            />
          )}
          {tab === "marketplaces" && (
            <MarketplacesTab plugins={plugins} hideError={pluginPanel} />
          )}
        </section>
      )}
      {account.shared && agentsSeen && (
        <section
          role="tabpanel"
          id="underline-tabpanel-agents"
          aria-labelledby="underline-tab-agents"
          className="extension-tabpanel"
          hidden={tab !== "agents"}
        >
          <AgentsTab
            account={account}
            request={request}
            setParentBusy={busySetters.agency}
            mode={agentMode}
            setMode={setAgentMode}
            onCount={setAgentCount}
          />
        </section>
      )}
      {panel === "mcp" && (
        <McpForm {...ext} request={request} subtitle={subtitle} close={closePanel} />
      )}
      {panel === "skill" && (
        <SkillInstallForm
          {...ext}
          request={request}
          subtitle={subtitle}
          close={closePanel}
        />
      )}
      {panel === "market" && (
        <PluginSourceForm
          title={marketplacesCopy.addMarketplace}
          subtitle={subtitle}
          label={marketplacesCopy.extensionWide}
          placeholder={marketplacesCopy.extensionWidePlaceholder}
          description={marketplacesCopy.marketplaceSourceDescription}
          submitLabel={marketplacesCopy.addMarketplace}
          value={plugins.source}
          setValue={plugins.setSource}
          disabled={plugins.disabled}
          busy={plugins.busy}
          error={plugins.error}
          close={closePanel}
          submit={() =>
            plugins.mutate(
              { action: "marketplace-add", source: plugins.source.trim() },
              marketplacesCopy.extensionInstallOnSubmit,
              () => {
                plugins.setSource("");
                closePanel();
              },
            )
          }
        />
      )}
      {panel === "npm" && (
        <PluginSourceForm
          title={profilePluginsCopy.extensionInstallHeading}
          subtitle={subtitle}
          label={profilePluginsCopy.extensionWide}
          placeholder={profilePluginsCopy.extensionWidePlaceholder}
          description={profilePluginsCopy.packageSourceDescription}
          submitLabel={profilePluginsCopy.installPackage}
          value={plugins.pkg}
          setValue={plugins.setPkg}
          disabled={plugins.disabled || !plugins.capabilities.install}
          busy={plugins.busy}
          error={plugins.error}
          close={closePanel}
          submit={() =>
            plugins.mutate(
              { action: "install", source: plugins.pkg.trim() },
              profilePluginsCopy.extensionInstallOnSubmit,
              () => {
                plugins.setPkg("");
                closePanel();
              },
            )
          }
        />
      )}
    </section>
  );
}
