import React, { useMemo, useState } from "react";
import ListDetail from "../../components/ListDetail.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  extensionsPageCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import ExtensionWorkspace from "./ExtensionWorkspace.jsx";
import { extensionProfiles } from "./sharedProfiles.js";
import "./extensions-hub.css";

const busySources = ["extensions", "plugins", "agency"];

export default function ExtensionsPage({
  shared = false,
  accounts = [],
  request,
  profileId,
  extensionTab = "mcp",
  onNavigate,
}) {
  const profiles = extensionProfiles(accounts, shared);
  const [busy, setBusy] = useState({});
  // Each data source reports its own pending mutation; the profile list and tabs
  // stay locked until every source has finished.
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
  const account =
    profiles.find((item) => item.id === profileId) || (!profileId ? profiles[0] : null);
  const go = (next) =>
    onNavigate({
      view: "extensions",
      profileId: account?.id,
      extensionTab,
      ...next,
    });
  return (
    <div className="page extensions-page extensions-hub">
      <div className="page-topline">
        <span>{copy.eyebrow}</span>
        <span className="subtle">{copy.subtitle}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </header>
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
              <small>{shared ? hub.sharedProfile : names[item.tool] || item.tool}</small>
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
              onTab={(extensionTab) => go({ extensionTab })}
              busySetters={busySetters}
              locked={locked}
            />
          ) : (
            <p className="loading" role="status">
              {commonCopy.profilesLoading}
            </p>
          )
        }
      />
    </div>
  );
}
