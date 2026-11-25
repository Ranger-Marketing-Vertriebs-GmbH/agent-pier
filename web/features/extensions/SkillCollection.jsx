import React, { useId } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { profileExtensionsCopy } from "../../lib/i18n/messages/extensions.js";
import {
  skillCollectionCopy as copy,
  skillScanCopy as scanCopy,
} from "../../lib/i18n/messages/skill-scan.js";
import { serverText } from "../../lib/server-messages.js";
import { visibleText } from "./SkillScanPreview.jsx";
import "./skill-scan.css";

const tones = { ok: "ok", warn: "waiting", block: "error" };

/** A skill the catalog can take from this source: new, or a newer version. */
export const offered = (skill) => skill.state === "new" || skill.state === "update";
/** Offered and without an open decision, so it installs together with the others. */
export const selectable = (skill) => offered(skill) && !skill.review;

const problemText = (problem) =>
  serverText(problem?.message, problem?.messageKey, problem?.messageArgs);

function Row({ skill, picked, toggle, added, skipped, busy, onReview }) {
  const name = visibleText(skill.name || skill.folder);
  const review = offered(skill) && skill.review && !added;
  return (
    <div className="skill-collection-item">
      <CheckRow
        title={name}
        subtitle={skill.description ? visibleText(skill.description) : undefined}
        checked={picked}
        disabled={busy || added || !selectable(skill)}
        onChange={(event) => toggle(skill.folder, event.target.checked)}
      >
        {skill.name && (
          <span className="skill-collection-line" dir="ltr">
            {copy.location(visibleText(skill.folder), skill.files)}
          </span>
        )}
        {added ? (
          <StatusChip tone="ok">{copy.added}</StatusChip>
        ) : offered(skill) ? (
          <>
            <StatusChip tone={tones[skill.verdict] || "neutral"}>
              {scanCopy.verdicts[skill.verdict]}
            </StatusChip>
            {skill.replaces && (
              <span className="skill-collection-line">
                {copy.updateOf(skill.replaces.version)}
              </span>
            )}
            {skill.review && (
              <span className="skill-collection-line">{copy.needsReview}</span>
            )}
          </>
        ) : (
          <span className="skill-collection-line">
            {copy.states[skill.state] || copy.states.invalid}
            {skill.problem ? ` · ${problemText(skill.problem)}` : ""}
          </span>
        )}
        {skipped && !added && (
          <span className="skill-collection-line skill-collection-refused">
            {problemText(skipped)}
          </span>
        )}
      </CheckRow>
      {review && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          aria-label={copy.reviewLabel(name)}
          onClick={() => onReview(skill.folder)}
        >
          {copy.reviewAction}
        </button>
      )}
    </div>
  );
}

/**
 * The skills of a checked source that holds several: one row per skill with its scan
 * verdict. Skills without an open decision are picked and install together; one with
 * findings opens its own preview (`onReview`); the others say why they are not offered.
 * `picked` and `added` are sets of folders, `skipped` maps a folder to the refusal of
 * the last install.
 */
export default function SkillCollection({
  collection,
  picked,
  setPicked,
  added,
  skipped,
  busy,
  onReview,
}) {
  const headingId = useId();
  const origin = collection.origin;
  const free = collection.skills.filter(
    (skill) => selectable(skill) && !added.has(skill.folder),
  );
  const all = free.length > 0 && free.every((skill) => picked.has(skill.folder));
  function toggle(folder, on) {
    const next = new Set(picked);
    if (on) next.add(folder);
    else next.delete(folder);
    setPicked(next);
  }
  return (
    <section className="skill-collection" aria-labelledby={headingId}>
      <div className="skill-collection-head">
        <h3 id={headingId}>{copy.heading(collection.skills.length)}</h3>
        {origin?.kind === "github" && (
          <p>
            {profileExtensionsCopy.githubOrigin(
              origin.repository,
              origin.refKind,
              origin.ref,
              origin.commit,
            )}
          </p>
        )}
        <p className="field-description">{copy.lead}</p>
      </div>
      {free.length > 1 && (
        <div className="extension-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              setPicked(new Set(all ? [] : free.map((skill) => skill.folder)))
            }
          >
            {all ? copy.selectNone : copy.selectAll}
          </button>
        </div>
      )}
      <div className="skill-collection-list" role="group" aria-label={copy.listLabel}>
        {collection.skills.map((skill) => (
          <Row
            key={skill.folder}
            skill={skill}
            picked={picked.has(skill.folder)}
            toggle={toggle}
            added={added.has(skill.folder)}
            skipped={skipped.get(skill.folder)}
            busy={busy}
            onReview={onReview}
          />
        ))}
      </div>
      <p className="field-description">{scanCopy.offlineNote}</p>
    </section>
  );
}
