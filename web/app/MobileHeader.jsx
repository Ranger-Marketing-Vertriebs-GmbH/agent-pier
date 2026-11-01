import { mobileHeaderCopy as copy, sidebarCopy } from "../lib/i18n/messages/app.js";
import React from "react";
import SidebarNewMenu from "./SidebarNewMenu.jsx";
import useNewMenuItems from "./useNewMenuItems.js";
import Icon from "../components/Icon.jsx";
import { InboxHeaderButton } from "../features/inbox/InboxEntry.jsx";
import useSearchDialog from "./search-dialog.js";
export default function MobileHeader({
  mobileNav,
  setMobileNav,
  select,
  launch,
  navigate,
  installed,
}) {
  const items = useNewMenuItems({ launch, navigate });
  const search = useSearchDialog();
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
        <button
          type="button"
          className="icon-button"
          aria-label={sidebarCopy.searchRow}
          title={sidebarCopy.searchRow}
          onClick={() => search.open()}
        >
          <Icon name="search" />
        </button>
        <InboxHeaderButton onOpen={() => navigate({ view: "inbox" })} />
        <SidebarNewMenu align="right" items={items} disabled={!installed} />
      </div>
    </div>
  );
}
