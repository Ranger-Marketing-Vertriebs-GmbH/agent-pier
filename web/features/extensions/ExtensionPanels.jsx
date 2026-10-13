import React from "react";
import { marketplacesCopy, profilePluginsCopy } from "../../lib/i18n/messages/plugins.js";
import PluginSourceForm from "../plugins/PluginSourceForm.jsx";
import SkillInstallForm from "./SkillInstallForm.jsx";

// The add panels of a profile: a skill, a marketplace source or an OpenCode package.
export default function ExtensionPanels({
  panel,
  ext,
  plugins,
  request,
  subtitle,
  submitted,
  setSubmitted,
  close,
}) {
  // A plugin panel shows only errors of its own submission, never an older one.
  const error = submitted ? plugins.error : "";
  if (panel === "skill")
    return (
      <SkillInstallForm {...ext} request={request} subtitle={subtitle} close={close} />
    );
  if (panel === "market")
    return (
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
        error={error}
        close={close}
        submit={() => {
          setSubmitted(true);
          plugins.mutate(
            { action: "marketplace-add", source: plugins.source.trim() },
            marketplacesCopy.extensionInstallOnSubmit,
            () => {
              plugins.setSource("");
              close();
            },
          );
        }}
      />
    );
  if (panel === "npm")
    return (
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
        error={error}
        close={close}
        submit={() => {
          setSubmitted(true);
          plugins.mutate(
            { action: "install", source: plugins.pkg.trim() },
            profilePluginsCopy.extensionInstallOnSubmit,
            () => {
              plugins.setPkg("");
              close();
            },
          );
        }}
      />
    );
  return null;
}
