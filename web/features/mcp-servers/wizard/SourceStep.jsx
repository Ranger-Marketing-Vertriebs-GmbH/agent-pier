import React, { useState } from "react";
import { mcpDirectoryCopy as directoryCopy } from "../../../lib/i18n/messages/mcp-directory.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { SettingsLink } from "./DirectoryStep.jsx";
import useDirectoryStatus from "./useDirectoryStatus.js";
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

/** Why the directory card cannot be used, or what it offers. */
function DirectoryHint({ directory, navigate }) {
  const { status, error } = directory;
  if (status && !status.enabled)
    return (
      <>
        {directoryCopy.turnedOff} <SettingsLink navigate={navigate} />
      </>
    );
  if (error || (status && !status.reachable)) return directoryCopy.unreachable;
  return directoryCopy.sourceCardHint;
}

/** "Where does the server come from?" – native radio cards in one fieldset. */
export default function SourceStep({ state, dispatch, go, headingRef, navigate }) {
  const directory = useDirectoryStatus();
  const usable = Boolean(directory.status?.enabled && directory.status.reachable);
  const [choice, setChoice] = useState(
    state.via === "directory" ? "directory" : (state.path ?? "package"),
  );
  // A directory that turned off or unreachable leaves no card chosen to continue with.
  const picked = choice === "directory" && !usable ? null : choice;
  return (
    <WizardStep
      title={copy.source.title}
      headingRef={headingRef}
      primary={{ label: copy.continue, disabled: !picked }}
      onSubmit={() => {
        if (!picked) return;
        if (picked === "directory") {
          dispatch({ type: "via", via: "directory" });
          dispatch({ type: "dismiss" });
          go("directory");
          return;
        }
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
        <label className={`mcp-wizard-card${usable ? "" : " is-disabled"}`}>
          <input
            type="radio"
            name="mcp-wizard-source"
            value="directory"
            disabled={!usable}
            checked={choice === "directory"}
            onChange={() => setChoice("directory")}
          />
          <span className="mcp-wizard-card-title">{directoryCopy.sourceCard}</span>
          <small className="mcp-hint">
            <DirectoryHint directory={directory} navigate={navigate} />
          </small>
        </label>
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
