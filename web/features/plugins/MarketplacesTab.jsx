import React from "react";
import CatalogAccount from "./CatalogAccount.jsx";
import Marketplaces from "./Marketplaces.jsx";
import PluginFrame from "./PluginFrame.jsx";

export default function MarketplacesTab({ plugins, account, hideError }) {
  const { data, disabled, mutate, setConfirm } = plugins;
  return (
    <PluginFrame
      plugins={plugins}
      hideError={hideError}
      before={<CatalogAccount plugins={plugins} account={account} />}
    >
      {data && <Marketplaces {...{ data, disabled, mutate, setConfirm }} />}
    </PluginFrame>
  );
}
