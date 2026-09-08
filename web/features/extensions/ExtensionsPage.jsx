import { extensionsPageCopy as copy } from "../../lib/i18n/messages/extensions.js";
import React from "react";
import ProfilePage from "../../components/ProfilePage.jsx";
import ProfileExtensions from "./ProfileExtensions.jsx";
export default function ExtensionsPage(props) {
  return (
    <ProfilePage
      {...props}
      eyebrow={copy.eyebrow}
      subtitle={copy.subtitle}
      title={copy.title}
      description={copy.description}
      component={ProfileExtensions}
    />
  );
}
