import React from "react";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow from "../../../../components/ListRow.jsx";
import { routePath } from "../../../../app/routes.js";
import { useCrossLink } from "../../../../app/cross-link.js";
import { assistantMailCopy as copy } from "../../../../lib/i18n/messages/assistant-mail.js";
import { connectionsRoute } from "../../../connections/routes.js";
import {
  agentRoute,
  invalidMailGrants,
  mailLevels,
  setMailGrant,
} from "../agent-settings-fields.js";
import AccessGroup from "./AccessGroup.jsx";
import GrantRow from "./GrantRow.jsx";
import { addMailGrants, candidatesOf } from "./access-groups.js";

/**
 * Email: the accounts this agent may use, each at Read or Read and send. Recipient
 * rules (send without asking) live on the subpage (`page=mail`). `accounts` is
 * undefined while loading and null when the catalog could not be read; grants of
 * removed accounts are listed to drop on save. An agent with a Telegram bot for other
 * people cannot hold mail: it sees why instead of the add field.
 */
export default function MailAccess({
  assistantId,
  accounts,
  draft,
  disabled,
  locked = false,
  go,
  navigate,
}) {
  const crossLink = useCrossLink();
  const grants = draft.values.mailAccesses;
  const known = accounts || [];
  const accountOf = new Map(known.map((a) => [a.id, a]));
  const entries = accounts
    ? grants.map((grant) => ({ ...grant, account: accountOf.get(grant.accountId) }))
    : [];
  const set = (next) => draft.set("mailAccesses", next);
  const levelOptions = mailLevels.map((value) => ({ value, label: copy.levels[value] }));
  // A send grant names its own rule count; rules the server would refuse block saving.
  const sub = (entry) =>
    entry.level === "send"
      ? `${entry.account.address} · ${copy.rulesCount(entry.recipients.length)}`
      : entry.account.address;
  const invalid = new Set(invalidMailGrants(grants));
  const rulesRoute = agentRoute(assistantId, "access", "mail");
  const sending = entries.some((entry) => entry.account && entry.level === "send");
  return (
    <AccessGroup
      id="agent-access-mail"
      title={copy.title}
      hint={copy.intro}
      entries={entries}
      total={accounts ? known.length : null}
      loading={accounts === undefined}
      more={{ route: rulesRoute, open: () => go("access", "mail") }}
      renderRow={(entry) =>
        entry.account ? (
          <GrantRow
            key={entry.accountId}
            id={entry.accountId}
            name={entry.account.name}
            sub={sub(entry)}
            pill={locked ? copy.levels[entry.level] : undefined}
            disabled={disabled}
            mode={
              locked
                ? undefined
                : {
                    label: copy.levelLabel(entry.account.name),
                    value: entry.level,
                    options: levelOptions,
                    onChange: (level) =>
                      set(setMailGrant(grants, entry.accountId, level)),
                  }
            }
            onRevoke={() => set(setMailGrant(grants, entry.accountId, null))}
          />
        ) : (
          <GrantRow
            key={entry.accountId}
            id={entry.accountId}
            name={copy.removed}
            sub={copy.removedHint}
            disabled={disabled}
            onRevoke={() => set(setMailGrant(grants, entry.accountId, null))}
          />
        )
      }
      picker={
        locked
          ? undefined
          : {
              typeLabel: copy.type,
              candidates: candidatesOf(known, (account) => ({ sub: account.address })),
              granted: grants.map((grant) => grant.accountId),
              modes: levelOptions,
              defaultMode: "read",
              disabled,
              onAdd: (items, level) =>
                set(
                  addMailGrants(
                    grants,
                    items.map((item) => item.id),
                    level,
                  ),
                ),
            }
      }
      setup={
        locked
          ? undefined
          : { title: copy.manage, route: crossLink(connectionsRoute("mail")), navigate }
      }
      notes={
        <>
          {accounts === null && <ErrorMessage error={copy.loadError} />}
          {entries
            .filter((entry) => entry.account && invalid.has(entry.accountId))
            .map((entry) => (
              <ErrorMessage
                key={entry.accountId}
                error={copy.rulesInvalid(entry.account.name)}
              />
            ))}
          {locked && (
            <p className="agent-locked-notice" role="note">
              {copy.telegramSenders}
            </p>
          )}
        </>
      }
    >
      {sending && (
        <ListCard label={copy.rulesRow}>
          <ListRow
            label={copy.rulesRow}
            sub={copy.rulesLabel}
            href={routePath(rulesRoute)}
            onClick={() => go("access", "mail")}
          />
        </ListCard>
      )}
    </AccessGroup>
  );
}
