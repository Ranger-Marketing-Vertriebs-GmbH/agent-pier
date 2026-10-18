import { mobileHeaderCopy as copy } from "../lib/i18n/messages/app.js";
import React from "react";
import SidebarNewMenu from "./SidebarNewMenu.jsx";
import useNewMenuItems from "./useNewMenuItems.js";
import Icon from "../components/Icon.jsx";
import { InboxHeaderButton } from "../features/inbox/InboxEntry.jsx";
export default function MobileHeader({
  mobileNav,
  setMobileNav,
  select,
  launch,
  navigate,
  installed,
}) {
  const items = useNewMenuItems({ launch, navigate });
  return (
    <div className="mobile-header">
      <button
        className="icon-button"
        aria-label={copy.iconButtonAriaLabel}
        aria-expanded={mobileNav}
        onClick={() => setMobileNav(true)}
      >
        <Icon name="menu" />
      </button>
      <button className="mobile-brand" onClick={() => select(null)}>
        {copy.mobileBrand}
        <span>.</span>
      </button>
      <div className="mobile-header-actions">
        <InboxHeaderButton onOpen={() => navigate({ view: "inbox" })} />
        <SidebarNewMenu icon align="right" items={items} disabled={!installed} />
      </div>
    </div>
  );
}
