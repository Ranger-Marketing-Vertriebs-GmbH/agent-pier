import React, { useCallback, useEffect, useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy,
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
import useProfilePlugins from "../plugins/useProfilePlugins.js";
import ExtensionPanels from "./ExtensionPanels.jsx";
import McpReferenceRow from "./McpReferenceRow.jsx";
import SkillsTab from "./SkillsTab.jsx";
import useProfileExtensions from "./useProfileExtensions.js";
import { primaryAction, resolveWorkspaceTab, workspaceTabs } from "./workspace-model.js";

// "+ Skill installieren" on the group label (phones); the "+" stays out of the name.
const groupAction = (primary) => ({
  label: (
    <>
      <span aria-hidden="true">+</span>
      {primary.label}
    </>
  ),
  onClick: primary.run,
  disabled: primary.disabled,
});

// One instance per profile (keyed by the page): the data hooks live here so
// switching tabs neither refetches nor drops notices, drafts or confirmations.
export default function ExtensionWorkspace({
  account,
  request,
  tab: requestedTab,
  onTab,
  busySetters,
  locked,
  onNavigate,
  serverCount,
  onConfigPath,
  install,
  onInstallDone,
  cliChoice,
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
  const [pluginDetail, setPluginDetail] = useState(null);
  const [agentMode, setAgentMode] = useState("installed");
  const [agentCount, setAgentCount] = useState(undefined);
  const [agentsSeen, setAgentsSeen] = useState(false);
  // null until the first plugin inventory arrives; afterwards the last known
  // value is kept while a catalog account reloads.
  const [catalogKnown, setCatalogKnown] = useState(null);
  const known = plugins.data ? Boolean(plugins.capabilities.marketplaces) : catalogKnown;
  if (known !== catalogKnown) setCatalogKnown(known);
  const supported = known === true;
  const [submitted, setSubmitted] = useState(false);
  const tabLabels = {
    skills: hub.tabSkills,
    plugins: hub.tabPlugins,
    marketplaces: hub.tabMarketplaces,
    subagents: hub.tabAgents,
  };
  const tabs = workspaceTabs({
    shared: account.shared,
    marketplaces: supported,
    counts: {
      skills: ext.data?.skills.items.length,
      plugins: plugins.data?.installed.length,
      marketplaces: plugins.data?.marketplaces.length,
      subagents: agentCount,
    },
  }).map((item) => ({ ...item, label: tabLabels[item.id] }));
  // A marketplaces deep link waits for the CLI's capabilities instead of
  // flashing a tab the CLI may not support.
  const { tab } = resolveWorkspaceTab(
    requestedTab,
    tabs.map((item) => item.id),
    known,
  );
  useEffect(() => {
    if (tab !== requestedTab) onTab(tab, true);
  }, [tab, requestedTab, onTab]);
  const configPath = ext.data?.mcp.path || "";
  useEffect(() => onConfigPath?.(configPath), [configPath, onConfigPath]);
  if (tab === "subagents" && !agentsSeen) setAgentsSeen(true);
  const openPanel = (kind) => {
    if (kind === "skill") ext.setError("");
    setSubmitted(false);
    setPanel(kind);
  };
  const closePanel = useCallback(() => setPanel(null), []);
  const action = primaryAction({
    tab,
    tool: account.tool,
    catalogSupported: supported,
    extensionsReady: Boolean(ext.data),
    pluginsReady: Boolean(plugins.data),
    pluginInstall: Boolean(plugins.capabilities.install),
  });
  const primary = {
    label: {
      skill: commonCopy.installSkill,
      npm: profilePluginsCopy.extensionInstallHeading,
      discover: pluginCatalogCopy.catalogHeading,
      market: marketplacesCopy.addMarketplace,
      catalog: hub.browseCatalog,
    }[action.kind],
    run: {
      skill: () => openPanel("skill"),
      npm: () => openPanel("npm"),
      discover: () => {
        setPluginDetail(null);
        setPluginMode("discover");
      },
      market: () => openPanel("market"),
      catalog: () => setAgentMode("catalog"),
    }[action.kind],
    disabled: action.disabled || locked,
  };
  const groupText = {
    skills: hub.tabSkills,
    plugins:
      supported && pluginMode === "discover"
        ? pluginCatalogCopy.extensionSectionLabel
        : commonCopy.installed,
    marketplaces: hub.tabMarketplaces,
    subagents: hub.tabAgents,
  }[tab];
  const groupLabel = !(tab === "plugins" && pluginDetail) && (
    <GroupLabel
      as="h3"
      hint={
        tab === "skills" && account.tool === "codex"
          ? profileExtensionsCopy.extensionScopeNote
          : undefined
      }
      action={groupAction(primary)}
    >
      {groupText}
    </GroupLabel>
  );
  const extPanel = panel === "skill";
  // A plugin panel shows only errors of its own submission, never an older one.
  const pluginPanel = (panel === "market" || panel === "npm") && submitted;
  const extProps = { ext, account, request, hideError: extPanel };
  return (
    <section className="extension-hub-card" aria-labelledby="extension-hub-profile">
      <header className="extension-hub-header">
        <div>
          <h2 id="extension-hub-profile">{account.name}</h2>
          <span>
            {names[account.tool] || account.tool}
            {configPath && (
              <>
                {" · "}
                <code>{configPath}</code>
              </>
            )}
          </span>
        </div>
        <div className="extension-hub-primary">
          <button
            type="button"
            className="button primary"
            disabled={primary.disabled}
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
      {tab !== "subagents" && (
        <section
          role="tabpanel"
          id={`underline-tabpanel-${tab}`}
          aria-labelledby={`underline-tab-${tab}`}
          className="extension-tabpanel"
        >
          {groupLabel}
          {tab === "skills" && <SkillsTab {...extProps} />}
          {tab === "plugins" && (
            <PluginsTab
              plugins={plugins}
              account={account}
              mode={pluginMode}
              setMode={setPluginMode}
              catalogSupported={supported}
              hideError={pluginPanel}
              detail={pluginDetail}
              setDetail={setPluginDetail}
            />
          )}
          {tab === "marketplaces" && (
            <MarketplacesTab
              plugins={plugins}
              account={account}
              hideError={pluginPanel}
            />
          )}
          {(tab === "skills" || (tab === "plugins" && !pluginDetail)) && (
            <McpReferenceRow
              tool={account.tool}
              count={serverCount}
              onNavigate={onNavigate}
            />
          )}
        </section>
      )}
      {account.shared && agentsSeen && (
        <section
          role="tabpanel"
          id="underline-tabpanel-subagents"
          aria-labelledby="underline-tab-subagents"
          className="extension-tabpanel"
          hidden={tab !== "subagents"}
        >
          {tab === "subagents" && groupLabel}
          <AgentsTab
            account={account}
            request={request}
            setParentBusy={busySetters.agency}
            mode={agentMode}
            setMode={setAgentMode}
            onCount={setAgentCount}
            onNavigate={onNavigate}
            install={tab === "subagents" ? install : ""}
            onInstallDone={onInstallDone}
            cliChoice={cliChoice}
          />
        </section>
      )}
      <ExtensionPanels
        panel={panel}
        ext={ext}
        plugins={plugins}
        request={request}
        subtitle={hub.panelSubtitle(account.name)}
        submitted={submitted}
        setSubmitted={setSubmitted}
        close={closePanel}
      />
    </section>
  );
}
