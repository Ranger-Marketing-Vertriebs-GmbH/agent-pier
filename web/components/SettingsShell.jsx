import React from "react";
import Icon from "./Icon.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { mobileHeaderCopy } from "../lib/i18n/messages/app.js";

// Header + tabs + content column + bottom bar for settings-like pages.
export default function SettingsShell({
  title,
  subtitle,
  description,
  leading = null,
  onLeading,
  leadingLabel,
  navigationOpen = false,
  actions,
  tabs,
  bar,
  className = "",
  children,
}) {
  const menu = leading === "menu";
  return (
    <div className={["settings-shell", className].filter(Boolean).join(" ")}>
      <header
        className={["settings-shell-header", tabs ? "has-tabs" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="settings-shell-heading">
          {leading && (
            <button
              type="button"
              className={`settings-shell-leading ${leading}`}
              aria-label={
                leadingLabel ??
                (menu ? mobileHeaderCopy.iconButtonAriaLabel : commonCopy.back)
              }
              aria-expanded={menu ? navigationOpen : undefined}
              onClick={onLeading}
            >
              <Icon name={menu ? "menu" : "back"} />
            </button>
          )}
          <div
            className={["settings-shell-title", description ? "has-description" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <h1>{title}</h1>
            {subtitle && <div className="settings-shell-subtitle">{subtitle}</div>}
            {description && <p className="settings-shell-description">{description}</p>}
          </div>
          {actions && <div className="settings-shell-actions">{actions}</div>}
        </div>
        {tabs && <div className="settings-shell-tabs">{tabs}</div>}
      </header>
      <div className="settings-shell-body">
        <div className="settings-shell-content">{children}</div>
      </div>
      {bar}
    </div>
  );
}
