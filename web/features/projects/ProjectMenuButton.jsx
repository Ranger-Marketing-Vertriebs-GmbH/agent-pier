import React from "react";
import Icon from "../../components/Icon.jsx";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";

/**
 * A ⋯ button with its menu: the row-menu popover on desktop, or, given `sheet`
 * (`{ title, subtitle }`, phones), the same items in a bottom sheet. Further props
 * (`data-*`) go to the button.
 */
export default function ProjectMenuButton({ label, items, sheet, className, ...rest }) {
  const menu = useRowMenu();
  return (
    <>
      <button
        {...rest}
        type="button"
        className={`icon-button ${className}`}
        aria-label={label}
        aria-haspopup={sheet ? "dialog" : "menu"}
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon name="more" size={18} />
      </button>
      <RowMenu label={label} state={menu} items={items} sheet={sheet} />
    </>
  );
}
