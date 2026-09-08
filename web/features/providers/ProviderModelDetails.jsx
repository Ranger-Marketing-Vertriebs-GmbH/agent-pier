import React from "react";
import { providerCopy as copy } from "../../lib/i18n/de/providers.js";
import { locale, formatTimestamp } from "../../lib/i18n/index.js";

const number = new Intl.NumberFormat(locale);
function limit(value) {
  return Number.isSafeInteger(value) && value > 0
    ? copy.tokens(number.format(value))
    : copy.unknown;
}
export default function ProviderModelDetails({ model, tool }) {
  if (!model) return null;
  const assumed =
    model.assumedContextTokens ?? (tool === "codex" ? model.codexContextTokens : null);
  return (
    <div className="provider-model-details" role="group" aria-label={copy.limits}>
      <dl>
        <div>
          <dt>{copy.context}</dt>
          <dd>{limit(model.contextTokens)}</dd>
        </div>
        <div>
          <dt>{copy.routingContext}</dt>
          <dd>{limit(model.routingContextTokens)}</dd>
        </div>
        <div>
          <dt>{copy.output}</dt>
          <dd>{limit(model.outputTokens)}</dd>
        </div>
        {assumed !== undefined && assumed !== null && (
          <div>
            <dt>{copy.assumedContext}</dt>
            <dd>{limit(assumed)}</dd>
          </div>
        )}
      </dl>
      <p className="field-description">{copy.contextNotice}</p>
      {model.source?.startsWith("https://") && (
        <a href={model.source} target="_blank" rel="noreferrer noopener">
          {copy.source}
        </a>
      )}
      {model.fetchedAt && (
        <p className="field-description">
          {copy.catalogDate}:{" "}
          <time dateTime={model.fetchedAt}>{formatTimestamp(model.fetchedAt)}</time>
        </p>
      )}
    </div>
  );
}
