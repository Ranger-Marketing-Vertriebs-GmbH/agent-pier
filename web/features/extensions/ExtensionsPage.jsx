import React, { useMemo, useState } from "react";
import ListDetail from "../../components/ListDetail.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  extensionsPageCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import ExtensionWorkspace from "./ExtensionWorkspace.jsx";
import ProfileSwitcher from "./ProfileSwitcher.jsx";
import { defaultExtensionTab } from "./routes.js";
import { extensionProfiles } from "./sharedProfiles.js";
import useMcpUsage from "./useMcpUsage.js";
import { cliServerCount } from "./workspace-model.js";
import "./extensions-hub.css";

const busySources = ["extensions", "plugins", "agency"];

export default function ExtensionsPage({
  shared = false,
  accounts = [],
  request,
  profileId,
  extensionTab = defaultExtensionTab,
  onNavigate,
  openNavigation,
  navigationOpen = false,
}) {
  const profiles = extensionProfiles(accounts, shared);
  const [busy, setBusy] = useState({});
  const [configPath, setConfigPath] = useState("");
  // Each data source reports its own pending mutation; the profile list, the profile
  // switcher and the tabs stay locked until every source has finished.
  const busySetters = useMemo(
    () =>
      Object.fromEntries(
        busySources.map((source) => [
          source,
          (value) => setBusy((current) => ({ ...current, [source]: Boolean(value) })),
        ]),
      ),
    [],
  );
  const locked = Object.values(busy).some(Boolean);
  const usage = useMcpUsage(request);
  const account =
    profiles.find((item) => item.id === profileId) || (!profileId ? profiles[0] : null);
  const sub = (item) => (shared ? hub.sharedProfile : names[item.tool] || item.tool);
  const go = (next, replace = false) =>
    onNavigate(
      {
        view: "extensions",
        profileId: account?.id,
        extensionTab,
        ...next,
      },
      replace,
    );
  return (
    <SettingsShell
      className="extensions-page extensions-hub"
      title={copy.title}
      description={copy.description}
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
      subtitle={
        account && (
          <ProfileSwitcher
            profiles={profiles}
            selected={account}
            sub={sub}
            configPath={configPath}
            locked={locked}
            onSelect={(id) => go({ profileId: id })}
          />
        )
      }
    >
      <ListDetail
        className="extension-profiles"
        listLabel={hub.profiles}
        items={profiles}
        selectedId={account?.id || ""}
        disabled={locked}
        onSelect={(id) => id && go({ profileId: id })}
        renderItem={(item) => (
          <>
            <ProviderMark tool={item.tool} small />
            <span className="extension-profile-name">
              <strong>{item.name}</strong>
              <small>{sub(item)}</small>
            </span>
          </>
        )}
        detail={
          account ? (
            <ExtensionWorkspace
              key={account.id}
              account={account}
              request={request}
              tab={extensionTab}
              onTab={(extensionTab, replace) => go({ extensionTab }, replace)}
              busySetters={busySetters}
              locked={locked}
              onNavigate={onNavigate}
              serverCount={cliServerCount(usage, account.tool)}
              onConfigPath={setConfigPath}
            />
          ) : (
            <p className="loading" role="status">
              {commonCopy.profilesLoading}
            </p>
          )
        }
      />
    </SettingsShell>
  );
}
