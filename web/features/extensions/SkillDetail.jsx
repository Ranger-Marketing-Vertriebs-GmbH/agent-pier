import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import "./skill-list.css";

/**
 * The detail view of one skill, opened from its row: status `chips`, the full
 * description under `descriptionLabel`, the caller's own sections (`children`), the
 * `facts` (`[term, value]`, empty values left out) under `factsLabel`, and `actions`.
 */
export default function SkillDetail({
  title,
  subtitle,
  close,
  closeDisabled,
  chips,
  descriptionLabel,
  description,
  factsLabel,
  facts,
  actions,
  children,
}) {
  const shown = facts.filter(([, value]) => value);
  return (
    <SidePanel
      title={title}
      subtitle={subtitle}
      close={close}
      closeDisabled={closeDisabled}
      cancelLabel={commonCopy.close}
    >
      {chips && <div className="skill-detail-chips">{chips}</div>}
      {description && (
        <section className="skill-detail-section">
          <GroupLabel as="h3">{descriptionLabel}</GroupLabel>
          <p className="skill-detail-description">{description}</p>
        </section>
      )}
      {children}
      {shown.length > 0 && (
        <section className="skill-detail-section">
          <GroupLabel as="h3">{factsLabel}</GroupLabel>
          <dl className="skill-facts">
            {shown.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {actions && <div className="skill-detail-actions">{actions}</div>}
    </SidePanel>
  );
}
