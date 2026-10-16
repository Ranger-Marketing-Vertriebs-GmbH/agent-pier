import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import WizardStep from "./WizardStep.jsx";

const cards = [
  {
    value: "package",
    title: () => copy.source.package,
    hint: () => copy.source.packageHint,
  },
  {
    value: "remote",
    title: () => copy.source.remote,
    hint: () => copy.source.remoteHint,
  },
  {
    value: "command",
    title: () => copy.source.command,
    hint: () => copy.source.commandHint,
    chip: () => copy.source.advanced,
  },
];

/** "Where does the server come from?" – native radio cards in one fieldset. */
export default function SourceStep({ state, dispatch, go, headingRef }) {
  const [choice, setChoice] = useState(state.path ?? "package");
  return (
    <WizardStep
      title={copy.source.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        if (choice !== state.path) dispatch({ type: "choose", path: choice });
        dispatch({ type: "dismiss" });
        go(choice);
      }}
    >
      {state.notice === "lost" && (
        <p className="mcp-wizard-notice" role="status">
          {copy.lost}
        </p>
      )}
      <fieldset className="mcp-wizard-cards">
        <legend className="visually-hidden">{copy.source.title}</legend>
        {cards.map((card) => (
          <label key={card.value} className="mcp-wizard-card">
            <input
              type="radio"
              name="mcp-wizard-source"
              value={card.value}
              checked={choice === card.value}
              onChange={() => setChoice(card.value)}
            />
            <span className="mcp-wizard-card-title">
              {card.title()}
              {card.chip && <span className="list-row-pill">{card.chip()}</span>}
            </span>
            <small className="mcp-hint">{card.hint()}</small>
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className="button secondary mcp-wizard-paste-row"
        onClick={() => {
          dispatch({ type: "via", via: "paste" });
          dispatch({ type: "dismiss" });
          go("paste");
        }}
      >
        {copy.source.paste}
      </button>
      <small className="mcp-hint">{copy.source.pasteHint}</small>
    </WizardStep>
  );
}
