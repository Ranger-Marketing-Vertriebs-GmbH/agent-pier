import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import Sheet from "../../components/Sheet.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import LogoutButton from "../login/LogoutButton.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";

/**
 * The user's way around her app: My agents, Account and Sign out, in a sheet. Her
 * app has no sidebar and no route of the owner's.
 */
export function UserMenu({ navigate }) {
  const [open, setOpen] = useState(false);
  const go = (route) => {
    setOpen(false);
    navigate(route);
  };
  return (
    <>
      <button
        type="button"
        className="icon-button user-menu-button"
        aria-label={copy.menu}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="menu" />
      </button>
      <Sheet open={open} title={copy.menu} onCancel={() => setOpen(false)}>
        <ListCard label={copy.menu}>
          <ListRow label={copy.myAgents} onClick={() => go({ view: "agents" })} />
          <ListRow label={copy.account} onClick={() => go({ view: "account" })} />
        </ListCard>
        <div className="sheet-actions">
          <LogoutButton className="button secondary" />
          <button type="button" className="button text" onClick={() => setOpen(false)}>
            {copy.close}
          </button>
        </div>
      </Sheet>
    </>
  );
}

/**
 * The bar above every user page: the brand on her start page, Back on subpages, the
 * page's title (`children` replace it, as the chat's agent header does) and her menu.
 */
export default function UserHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  actions,
  navigate,
  children,
}) {
  return (
    <header className="user-header">
      {onBack ? (
        <button
          type="button"
          className="icon-button user-header-back"
          aria-label={backLabel || commonCopy.back}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
      ) : (
        <span className="user-header-brand">{copy.brand}</span>
      )}
      <div className="user-header-title">
        {children ?? (
          <>
            <h1>{title}</h1>
            {subtitle && <p className="user-header-sub">{subtitle}</p>}
          </>
        )}
      </div>
      {actions}
      <UserMenu navigate={navigate} />
    </header>
  );
}
