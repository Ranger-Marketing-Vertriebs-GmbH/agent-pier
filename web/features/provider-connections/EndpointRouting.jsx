import React, { useId } from "react";
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

const reasonText = (reason) => {
  const reasons = connectionCopy.endpoint.routing.reasons;
  return reasons[reason] ?? reasons.other;
};

export default function EndpointRouting({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.routing;
  const id = useId();
  return (
    <fieldset className="endpoint-routing">
      <legend>{copy.title}</legend>
      <p className="field-description">{copy.help}</p>
      {ROUTE_TOOLS.map((tool) => {
        const options = routeOptions(draft, tool);
        const selected = options.find((o) => o.choice === draft.routing[tool]);
        const blocked = selected && !selected.available;
        const ids = {
          select: `${id}-${tool}`,
          uses: `${id}-${tool}-uses`,
          reason: `${id}-${tool}-reason`,
        };
        return (
          <div className="endpoint-route" key={tool}>
            {/* The label sits beside the select: inside a label, Playwright resolves
                each option to the label's control. aria-label names the select. */}
            <label htmlFor={ids.select}>{names[tool]}</label>
            <AnchoredSelect
              id={ids.select}
              label={copy.select(names[tool])}
              describedBy={blocked ? `${ids.uses} ${ids.reason}` : ids.uses}
              value={draft.routing[tool]}
              onChange={(choice) =>
                setDraft((current) => setRoute(current, tool, choice))
              }
              options={options.map((option) => {
                // The current choice stays selectable so a stored route never vanishes.
                const disabled =
                  !option.available && option.choice !== draft.routing[tool];
                const label = choiceLabel(tool, option);
                return {
                  value: option.choice,
                  label: disabled
                    ? copy.choiceUnavailable(label, reasonText(option.reason))
                    : label,
                  disabled,
                };
              })}
            />
            {/* One persistent live region per CLI, so route changes are announced. */}
            <div className="endpoint-route-status" aria-live="polite">
              <small id={ids.uses}>
                {copy.resolved(routeLabel(resolveDraftRoute(draft, tool)))}
              </small>
              {blocked && (
                <small id={ids.reason}>
                  {copy.unavailable(reasonText(selected.reason))}
                </small>
              )}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
