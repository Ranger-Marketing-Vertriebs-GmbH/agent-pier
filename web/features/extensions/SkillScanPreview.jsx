import React, { useId, useState } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { profileExtensionsCopy } from "../../lib/i18n/messages/extensions.js";
import { skillScanCopy as copy } from "../../lib/i18n/messages/skill-scan.js";
import "./skill-scan.css";

const tones = { ok: "ok", warn: "waiting", block: "error" };

/**
 * Hidden characters as `<U+XXXX>`. The server already sends excerpts this way; the
 * page applies it again so no excerpt or file name can reorder what it shows.
 */
export const visibleText = (text = "") =>
  String(text).replace(
    /[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\u{E0100}-\u{E01EF}\uFE00-\uFE0E]/gu,
    (char) =>
      char === "\t"
        ? char
        : `<U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );

function groupByFile(findings) {
  const groups = new Map();
  for (const finding of findings) {
    if (!groups.has(finding.file)) groups.set(finding.file, []);
    groups.get(finding.file).push(finding);
  }
  return [...groups];
}

function source(preview) {
  const origin = preview.origin;
  if (origin?.kind === "github")
    return profileExtensionsCopy.githubOrigin(
      origin.repository,
      origin.refKind,
      origin.ref,
      origin.commit,
    );
  return copy.importKinds[preview.importKind] || preview.importKind;
}

export function Finding({ finding }) {
  return (
    <li className={`skill-scan-finding skill-scan-${finding.severity}`}>
      <div className="skill-scan-finding-head">
        <span className="skill-scan-severity">{copy.severities[finding.severity]}</span>
        <strong>{copy.rules[finding.rule] || finding.rule}</strong>
        <span className="skill-scan-line">
          {finding.line ? copy.line(finding.line) : copy.wholeFile}
        </span>
      </div>
      {finding.excerpt && (
        <code className="skill-scan-excerpt" dir="ltr">
          {visibleText(finding.excerpt)}
        </code>
      )}
      <p className="skill-scan-hint">{copy.ruleHints[finding.rule]}</p>
    </li>
  );
}

/** The blocked case: a separate action, then a second confirmation naming the risks. */
function Override({ preview, busy, onInstall }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  if (!open)
    return (
      <div className="extension-actions">
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {copy.overrideAction}
        </button>
      </div>
    );
  return (
    <section className="extension-confirm skill-scan-override" aria-labelledby={titleId}>
      <h3 id={titleId}>{copy.overrideTitle}</h3>
      <p>{copy.overrideRisks}</p>
      <ul>
        {preview.blocking.map((rule) => (
          <li key={rule}>{copy.rules[rule] || rule}</li>
        ))}
      </ul>
      <p>{copy.overrideNote}</p>
      <div className="extension-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          {copy.backAction}
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => onInstall({ override: { rules: preview.blocking } })}
        >
          {copy.overrideConfirm}
        </button>
      </div>
    </section>
  );
}

/**
 * The scan result of a skill import: verdict, what is installed from where and the
 * findings grouped by file with line and excerpt. Warnings need the checkbox
 * (`accepted`), a block only installs through the override.
 */
export default function SkillScanPreview({
  preview,
  accepted,
  setAccepted,
  busy,
  onInstall,
}) {
  const headingId = useId();
  const size = Math.ceil(preview.size / 1024);
  return (
    <section className="skill-scan" aria-labelledby={headingId}>
      <h3 id={headingId} className="skill-scan-title">
        {copy.previewTitle}
      </h3>
      <div className={`skill-scan-verdict skill-scan-${preview.verdict}`}>
        <StatusChip tone={tones[preview.verdict]} pill>
          {copy.verdicts[preview.verdict]}
        </StatusChip>
        <p>{copy.verdictDescriptions[preview.verdict]}</p>
      </div>
      <dl className="skill-scan-details">
        <dt>{copy.nameLabel}</dt>
        <dd>
          <strong>{visibleText(preview.name)}</strong>
          <span>{visibleText(preview.description)}</span>
        </dd>
        <dt>{copy.sourceLabel}</dt>
        <dd>{source(preview)}</dd>
        <dt>{copy.filesLabel}</dt>
        <dd>{copy.filesSummary(preview.files.length, size)}</dd>
      </dl>
      {preview.findings.length > 0 && (
        <div className="skill-scan-findings">
          <h4>{copy.findingsHeading}</h4>
          {groupByFile(preview.findings).map(([file, findings]) => (
            <section key={file} aria-label={copy.findingsFor(visibleText(file))}>
              <h5>
                <code dir="ltr">{visibleText(file)}</code>
              </h5>
              <ul>
                {findings.map((finding, index) => (
                  <Finding
                    key={`${finding.rule}-${finding.line}-${index}`}
                    finding={finding}
                  />
                ))}
              </ul>
            </section>
          ))}
          {preview.truncated && <p className="field-description">{copy.truncated}</p>}
        </div>
      )}
      <p className="field-description">{copy.offlineNote}</p>
      {preview.verdict === "warn" && (
        <CheckRow
          title={copy.acceptWarnings}
          checked={accepted}
          disabled={busy}
          onChange={(event) => setAccepted(event.target.checked)}
        />
      )}
      {preview.verdict === "block" && (
        <Override preview={preview} busy={busy} onInstall={onInstall} />
      )}
    </section>
  );
}
