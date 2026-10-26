import React, { useCallback, useMemo, useState } from "react";
import ListDetail from "../../components/ListDetail.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import CodingFrame from "../coding/CodingFrame.jsx";
import { codingRoute } from "../coding/routes.js";
import ExtensionWorkspace from "./ExtensionWorkspace.jsx";
import ProfileSwitcher from "./ProfileSwitcher.jsx";
import { extensionProfiles } from "./sharedProfiles.js";
import useMcpUsage from "./useMcpUsage.js";
import { cliServerCount } from "./workspace-model.js";
import "./extensions-hub.css";

const busySources = ["extensions", "plugins", "agency"];

/**
 * Coding › Erweiterungen: the CLI profiles beside one profile's skills, plugins,
 * marketplaces and subagents. `install` names a subagent whose install preview opens
 * (from the agents hub's templates); it stays while the profile changes, so the
 * preview follows the chosen CLI, and is dropped once the preview closes.
 */
export default function ExtensionsPage({
  frame,
  shared = false,
  accounts = [],
  request = api,
  profileId,
  extensionTab = "skills",
  install = "",
  onNavigate,
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
  // A new tab drops the install request; a new profile keeps it.
  const go = (next, replace = false) =>
    onNavigate(
      codingRoute("extensions", {
        profileId: account?.id || "",
        extensionTab,
        ...(install && !next.extensionTab ? { install } : {}),
        ...next,
      }),
      replace,
    );
  const finishInstall = useCallback(
    () =>
      onNavigate(
        codingRoute("extensions", { profileId: account?.id || "", extensionTab }),
        true,
      ),
    [onNavigate, account?.id, extensionTab],
  );
  return (
    <CodingFrame
      {...frame}
      disabled={locked}
      className="extensions-page extensions-hub"
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
              install={install}
              onInstallDone={finishInstall}
              cliChoice={{ profiles, onSelect: (id) => go({ profileId: id }) }}
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
    </CodingFrame>
  );
}
