import React from "react";
import Marketplaces from "./Marketplaces.jsx";
import PluginFrame from "./PluginFrame.jsx";

export default function MarketplacesTab({ plugins, hideError }) {
  const { data, disabled, mutate, setConfirm } = plugins;
  return (
    <PluginFrame plugins={plugins} hideError={hideError}>
      {data && <Marketplaces {...{ data, disabled, mutate, setConfirm }} />}
    </PluginFrame>
  );
}
