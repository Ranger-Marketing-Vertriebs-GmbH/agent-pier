import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow, RadioRow } from "../../../components/ListRow.jsx";
import { useCrossLink } from "../../../app/cross-link.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import { assistantMailCopy as copy } from "../../../lib/i18n/messages/assistant-mail.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { connectionsRoute } from "../../connections/routes.js";
import { mailLevels, recipientLines, setMailGrant } from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";
import "./ssh-grant-page.css";

/**
 * The recipient rules of one send grant as a text field, one rule per line. The text
 * stays as typed; the draft holds its trimmed lines and the field follows the draft
 * when it changes from outside (a save returns the server's sorted rules, Reload).
 */
function RecipientRules({ accountId, recipients, disabled, onChange }) {
  const id = useId();
  const [text, setText] = useState(recipients.join("\n"));
  useEffect(() => {
    if (!sameValue(recipientLines(text), recipients)) setText(recipients.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients]);
  return (
    <div className="agent-field" data-mail-rules={accountId}>
      <label htmlFor={`${id}-rules`}>{copy.rulesLabel}</label>
      <textarea
        id={`${id}-rules`}
        rows={3}
        value={text}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="none"
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          setText(event.target.value);
          onChange(recipientLines(event.target.value));
        }}
      />
      <span id={`${id}-hint`} className="field-description">
        {copy.rulesHint}
      </span>
    </div>
  );
}

/**
 * Email (`page=mail`): every email account with its level and, for Read and send, the
 * recipients it may send to without asking. Part of the Access draft. `accounts` is
 * undefined while loading and null when the catalog could not be read.
 */
export default function MailGrantPage({
  accounts,
  grants,
  disabled,
  locked = false,
  onChange,
  onRetry,
  onBack,
  navigate,
}) {
  const setup = useCrossLink()(connectionsRoute("mail"));
  const grantOf = new Map(grants.map((g) => [g.accountId, g]));
  const removed = accounts
    ? grants.filter((g) => !accounts.some((a) => a.id === g.accountId))
    : [];
  return (
    <section className="agent-subpage ssh-grant-page" aria-label={copy.title}>
      <SubpageHeader title={copy.title} tab="access" onBack={onBack} />
      <p className="assistant-note">{copy.intro}</p>
      <p className="assistant-note">{copy.approvalNote}</p>
      <p className="ssh-grant-warning">{copy.untrusted}</p>
      {locked && (
        <p className="agent-locked-notice" role="note">
          {copy.telegramSenders}
        </p>
      )}
      {accounts === null && (
        <div className="ssh-grant-state">
          <ErrorMessage error={copy.loadError} />
          <button type="button" className="button secondary" onClick={onRetry}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {accounts === undefined && (
        <ul className="ssh-grant-skeleton" aria-label={copy.loading}>
          {[0, 1, 2].map((n) => (
            <li key={n} />
          ))}
        </ul>
      )}
      {accounts?.length === 0 && (
        <div className="ssh-grant-state">
          <p>{copy.empty}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => navigate(setup)}
          >
            {copy.manage}
          </button>
        </div>
      )}
      {accounts?.length > 0 && (
        <ListCard label={copy.title}>
          {accounts.map((account) => {
            const grant = grantOf.get(account.id);
            // A held grant can always be lowered or revoked, never raised while locked.
            const blocked = disabled || (locked && !grant);
            return (
              <div key={account.id} className="ssh-grant-host">
                <CheckboxRow
                  label={account.name}
                  sub={account.address}
                  checked={!!grant}
                  disabled={blocked}
                  onChange={(on) =>
                    onChange(setMailGrant(grants, account.id, on ? "read" : null))
                  }
                />
                {grant && (
                  <div className="ssh-grant-modes">
                    <GroupLabel as="h3" id={`mail-level-${account.id}-label`}>
                      {copy.levelLegend}
                    </GroupLabel>
                    <ListCard
                      labelledBy={`mail-level-${account.id}-label`}
                      disabled={disabled}
                    >
                      {mailLevels.map((level) => (
                        <RadioRow
                          key={level}
                          name={`mail-level-${account.id}`}
                          value={level}
                          label={copy.levels[level]}
                          sub={copy.levelHints[level]}
                          checked={grant.level === level}
                          disabled={disabled || (locked && level === "send")}
                          onChange={(value) =>
                            onChange(setMailGrant(grants, account.id, value))
                          }
                        />
                      ))}
                    </ListCard>
                    {grant.level === "send" && (
                      <RecipientRules
                        accountId={account.id}
                        recipients={grant.recipients}
                        disabled={disabled}
                        onChange={(recipients) =>
                          onChange(setMailGrant(grants, account.id, "send", recipients))
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </ListCard>
      )}
      {removed.length > 0 && (
        <ListCard label={copy.removed}>
          {removed.map((g) => (
            <div key={g.accountId} className="ssh-grant-removed" aria-disabled="true">
              <strong>{copy.removed}</strong>
              <small>{copy.removedHint}</small>
            </div>
          ))}
        </ListCard>
      )}
    </section>
  );
}
