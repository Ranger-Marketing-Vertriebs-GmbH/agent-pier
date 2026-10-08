import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { names } from "../../lib/providers.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { resolveDraftRoute, routeOptions, ROUTE_TOOLS } from "./endpoint-routes.js";
import { protocolShortName, routeLabel } from "./route-label.js";
import { setRoute } from "./endpoint-draft.js";

function choiceLabel(tool, option) {
  const copy = connectionCopy.endpoint.routing.choices;
  if (option.choice === "auto") return copy.auto;
  if (option.choice === "off") return copy.off;
  const protocol = protocolShortName(option.source);
  if (tool === "opencode") return copy.sdk(protocol);
  return option.choice === "native" ? copy.native(protocol) : copy.adapter(protocol);
}

export default function EndpointRouting({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.routing;
  return (
    <fieldset className="endpoint-routing">
      <legend>{copy.title}</legend>
      <p className="field-description">{copy.help}</p>
      {ROUTE_TOOLS.map((tool) => {
        const options = routeOptions(draft, tool);
        const selected = options.find((o) => o.choice === draft.routing[tool]);
        return (
          <div className="endpoint-route" key={tool}>
            {/* Not a <label>: the select is named by aria-label, and inside a label
                Playwright resolves each option to the label's control. */}
            <div className="endpoint-route-field">
              <span>{names[tool]}</span>
              <AnchoredSelect
                label={copy.select(names[tool])}
                value={draft.routing[tool]}
                onChange={(choice) =>
                  setDraft((current) => setRoute(current, tool, choice))
                }
                options={options.map((option) => ({
                  value: option.choice,
                  label: choiceLabel(tool, option),
                  // The current choice stays selectable so a stored route never vanishes.
                  disabled: !option.available && option.choice !== draft.routing[tool],
                }))}
              />
            </div>
            <small>{copy.resolved(routeLabel(resolveDraftRoute(draft, tool)))}</small>
            {selected && !selected.available && (
              <small role="status">
                {copy.unavailable(copy.reasons[selected.reason])}
              </small>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
