import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { marketplacesCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowLines from "../extensions/RowLines.jsx";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { marketplaceLabel } from "./marketplace-label.js";

function MarketplaceRow({ marketplace: m, count, disabled, mutate, setConfirm }) {
  const menu = useRowMenu();
  const label = marketplaceLabel(m);
  const items = m.builtin
    ? []
    : [
        {
          id: "update",
          label: commonCopy.refresh,
          ariaLabel: commonCopy.updateMarketplaceLabel(m.name),
          disabled: disabled || m.updatable === false,
          run: () =>
            mutate(
              { action: "marketplace-update", marketplace: m.name },
              copy.buttonOnClick(m.name),
            ),
        },
        {
          id: "remove",
          label: commonCopy.remove,
          ariaLabel: commonCopy.removeMarketplaceLabel(m.name),
          danger: true,
          restoreFocus: false,
          disabled: disabled || m.removable === false,
          run: () =>
            setConfirm({
              action: "marketplace-remove",
              name: m.name,
              body: { action: "marketplace-remove", marketplace: m.name },
            }),
        },
      ];
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={label}
        sub={
          <RowLines
            lines={[
              `${m.builtin ? hub.builtin : hub.customMarketplace} · ${hub.pluginCount(count)}`,
              m.builtin ? (
                copy.builtinDescription
              ) : (
                <code key="source" className="extension-path">
                  {m.source}
                </code>
              ),
            ]}
          />
        }
        menu={
          items.length
            ? { label: hub.rowActions(label), expanded: menu.open, onClick: menu.toggle }
            : undefined
        }
      />
      {items.length > 0 && (
        <RowMenu label={hub.rowActions(label)} state={menu} items={items} />
      )}
    </div>
  );
}

export default function Marketplaces({ data, disabled, mutate, setConfirm }) {
  if (!data.marketplaces.length) return <p className="extension-empty">{copy.empty}</p>;
  return (
    <ListCard label={hub.tabMarketplaces} className="extension-list">
      {data.marketplaces.map((m) => (
        <MarketplaceRow
          key={m.name}
          marketplace={m}
          count={(data.catalog || []).filter((p) => p.marketplace === m.name).length}
          {...{ disabled, mutate, setConfirm }}
        />
      ))}
    </ListCard>
  );
}
