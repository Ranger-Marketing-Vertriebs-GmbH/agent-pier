import React from "react";
import Icon from "../../components/Icon.jsx";

export default function ExtensionHint({ children, className = "" }) {
  return (
    <div className={["extension-hint", className].filter(Boolean).join(" ")}>
      <Icon name="info" size={15} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
