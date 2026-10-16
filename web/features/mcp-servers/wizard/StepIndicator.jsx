import React from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { stageIndex, stages } from "./wizard-state.js";

/** The stages as an ordered list; the current one is marked for assistive technology. */
export default function StepIndicator({ path, step }) {
  const list = stages(path);
  const current = Math.max(0, stageIndex(path, step));
  return (
    <nav className="mcp-wizard-steps" aria-label={copy.stepsLabel}>
      <p className="visually-hidden">{copy.stepOf(current + 1, list.length)}</p>
      <ol>
        {list.map((stage, index) => (
          <li
            key={stage}
            aria-current={index === current ? "step" : undefined}
            className={
              index < current ? "is-done" : index === current ? "is-current" : ""
            }
          >
            <span className="mcp-wizard-dot" aria-hidden="true" />
            <span className="mcp-wizard-stage">{copy.stages[stage]}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
