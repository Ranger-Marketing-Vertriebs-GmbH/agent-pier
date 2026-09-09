import { commonCopy } from "../lib/i18n/messages/common.js";
import { mobileHeaderCopy as copy } from "../lib/i18n/messages/app.js";
import React from "react";
import Icon from "../components/Icon.jsx";
export default function MobileHeader({ setMobileNav, select, launch, installed }) {
  return (
    <div className="mobile-header">
      <button
        className="icon-button"
        aria-label={copy.iconButtonAriaLabel}
        onClick={() => setMobileNav(true)}
      >
        <Icon name="menu" />
      </button>
      <button className="mobile-brand" onClick={() => select(null)}>
        {copy.mobileBrand}
        <span>.</span>
      </button>
      <button
        className="icon-button"
        aria-label={commonCopy.newSession}
        onClick={() => launch()}
        disabled={!installed}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
