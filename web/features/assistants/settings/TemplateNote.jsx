import React from "react";
import { agentTemplateCopy as copy } from "../../../lib/i18n/messages/agent-templates.js";
import { Finding } from "../../extensions/SkillScanPreview.jsx";
import "../../extensions/skill-scan.css";

/**
 * Where an agent's instructions came from: the Agency entry, its pinned revision,
 * the MIT license and, before creating (`scan`), what the scan found in it.
 */
export default function TemplateNote({ template, findings = [], scan = true }) {
  return (
    <div className="agent-template-note" data-template={template.id}>
      <strong>{copy.from(template.name)}</strong>
      <span>
        <a href={template.source} target="_blank" rel="noreferrer">
          {copy.source}
        </a>
        {" · "}
        {copy.revision} <code>{template.revision.slice(0, 8)}</code>
        {" · "}
        {copy.license}
      </span>
      {scan && template.verdict === "warn" && (
        <div className="skill-scan-verdict skill-scan-warn" role="note">
          <p>{copy.warned}</p>
        </div>
      )}
      {scan && template.verdict === "block" && (
        <div className="skill-scan-verdict skill-scan-block" role="alert">
          <p>{copy.blocked}</p>
        </div>
      )}
      {findings.length > 0 && (
        <div className="skill-scan-findings">
          <ul>
            {findings.map((finding, n) => (
              <Finding key={n} finding={finding} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
