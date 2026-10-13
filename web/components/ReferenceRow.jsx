import React from "react";
import Icon from "./Icon.jsx";
import { isPlainClick } from "./link-click.js";
import { commonCopy } from "../lib/i18n/messages/common.js";

// A setting managed centrally: a dashed row that opens its Accounts subpage. With
// `href` it is a link that `onOpen` turns into in-app navigation; without one it is a
// button that calls `onOpen`.
export default function ReferenceRow({ title, sub, count, href, onOpen, linkLabel }) {
  const subtitle = sub === undefined ? commonCopy.centralInAccounts : sub;
  const body = (
    <>
      <span className="list-row-text">
        <span className="list-row-label">
          {title}
          {count != null && count !== "" && (
            <span className="reference-row-count">{` · ${count}`}</span>
          )}
        </span>
        {subtitle && <span className="list-row-sub">{subtitle}</span>}
      </span>
      <span className="reference-row-link">
        {linkLabel ?? commonCopy.accounts}
        <Icon name="external" size={13} />
      </span>
    </>
  );
  if (!href)
    return (
      <button type="button" className="reference-row" onClick={() => onOpen?.()}>
        {body}
      </button>
    );
  return (
    <a
      className="reference-row"
      href={href}
      onClick={(event) => {
        if (!onOpen || !isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      {body}
    </a>
  );
}
