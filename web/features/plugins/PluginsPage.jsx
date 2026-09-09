import { pluginsPageCopy as copy } from "../../lib/i18n/messages/plugins.js";
import React from "react";
import ProfilePage from "../../components/ProfilePage.jsx";
import ProfilePlugins from "./ProfilePlugins.jsx";
export default function PluginsPage(props) {
  return (
    <ProfilePage
      {...props}
      className="plugins-page"
      eyebrow={copy.pluginsPageEyebrow}
      subtitle={copy.pluginsPageSubtitle}
      title={copy.pluginsPageTitle}
      description={copy.pluginsPageDescription}
      loadingRole={undefined}
      component={ProfilePlugins}
    />
  );
}
