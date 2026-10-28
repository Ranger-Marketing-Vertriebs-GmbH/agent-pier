import React, { useEffect, useId, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { routePath } from "../../app/routes.js";
import api from "../../lib/api.js";
import { formatMessageTime } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionsAreaCopy as areaCopy } from "../../lib/i18n/messages/connections-area.js";
import { mailCopy as copy } from "../../lib/i18n/messages/mail.js";
import CategorySection from "../connections/CategorySection.jsx";
import ConnectionUsedBy from "../connections/ConnectionUsedBy.jsx";
import EmptyCategory from "../connections/EmptyCategory.jsx";
import ProblemMarker from "../connections/ProblemMarker.jsx";
import { problemRowIds, rowHasProblem } from "../connections/connection-categories.js";
import { auditRoute, connectionsRoute } from "../connections/routes.js";
import MailAccountForm from "./MailAccountForm.jsx";
import MailTestResult, { testPassed } from "./MailTestResult.jsx";
import { needsPlaintext } from "./mail-account-form.js";
import "./mail.css";

/** "ok", "failed" or "untested" from an account's stored last test. */
const testState = (account) =>
  !account.lastTest ? "untested" : testPassed(account.lastTest) ? "ok" : "failed";
const stateTone = { ok: "ok", failed: "error", untested: "idle" };

function testLine(account) {
  const state = testState(account);
  if (state === "untested") return copy.neverTested;
  const time = formatMessageTime(account.lastTest.at);
  return state === "ok" ? copy.testedOk(time) : copy.testedFailed(time);
}

function rowStatus(account) {
  const state = testState(account);
  if (state === "failed") return { tone: "error", text: copy.statusFailed };
  if (needsPlaintext(account)) return { tone: "warn", text: copy.plaintextShort };
  return state === "ok" ? { tone: "ok", text: copy.statusOk } : undefined;
}

/** "Last test" of a saved account: when, both sides' results, test again and Edit. */
function MailTestBox({ account, onTested, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = testState(account);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/mail/accounts/${encodeURIComponent(account.id)}/test`, "POST", {});
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      onTested();
    }
  };
  return (
    <section
      className={["connections-test", state === "failed" ? "is-failed" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label={copy.lastTest}
    >
      <h3 className="connections-eyebrow">{copy.lastTest}</h3>
      <p className="connections-test-line">
        <StatusDot tone={stateTone[state]} />
        <span>{testLine(account)}</span>
      </p>
      <MailTestResult result={account.lastTest} />
      <ErrorMessage error={error} />
      {busy && <p role="status">{copy.testing}</p>}
      <div className="connections-actions">
        <button
          type="button"
          className={`button ${state === "failed" ? "primary" : "secondary"} compact`}
          disabled={busy}
          onClick={run}
        >
          {copy.test}
        </button>
        <button type="button" className="button secondary compact" onClick={onEdit}>
          {areaCopy.edit}
        </button>
      </div>
    </section>
  );
}

/** The full view of one account: its fields, "Used by", Manage and the last test. */
function MailAccountView({ account, shared, onEdit, changed }) {
  const id = useId();
  const [deleting, setDeleting] = useState(false);
  const { navigate } = shared;
  const audit = auditRoute(account.id);
  const usage = shared.connectionUsage
    ? (shared.connectionUsage.mail?.[account.id] ?? null)
    : undefined;
  return (
    <div className="connections-full">
      <div className="connections-full-main">
        {needsPlaintext(account) && (
          <p className="mail-warning">{copy.plaintextActive}</p>
        )}
        <section className="connections-section" aria-labelledby={`${id}-account`}>
          <GroupLabel id={`${id}-account`}>{copy.account}</GroupLabel>
          <ListCard labelledBy={`${id}-account`}>
            <ListRow label={copy.address} value={account.address} />
            {account.displayName && (
              <ListRow label={copy.displayName} value={account.displayName} />
            )}
            <ListRow label={copy.username} value={account.imap?.username} />
          </ListCard>
        </section>
        <section className="connections-section" aria-labelledby={`${id}-servers`}>
          <GroupLabel id={`${id}-servers`}>{copy.servers}</GroupLabel>
          <ListCard labelledBy={`${id}-servers`}>
            {["imap", "smtp"].map((side) => (
              <ListRow
                key={side}
                label={copy[side]}
                value={copy.serverLine(
                  account[side].host,
                  account[side].port,
                  copy.securities[account[side].security] ?? account[side].security,
                )}
              />
            ))}
            <ListRow
              label={copy.saveSent}
              value={account.saveSent ? copy.yes : copy.no}
            />
          </ListCard>
        </section>
        <ConnectionUsedBy
          kind="mail"
          item={account}
          usage={usage}
          agentsEnabled={shared.agentsEnabled}
          assistants={shared.assistants}
          navigate={navigate}
          onChanged={shared.reloadAll}
        />
        <section className="connections-section" aria-labelledby={`${id}-manage`}>
          <GroupLabel id={`${id}-manage`}>{areaCopy.manage.title}</GroupLabel>
          <ListCard labelledBy={`${id}-manage`}>
            <ListRow
              label={areaCopy.manage.activity}
              sub={areaCopy.manage.activityHint}
              value={areaCopy.manage.activityLink}
              href={routePath(audit)}
              onClick={() => navigate(audit)}
            />
            <ListRow label={copy.deleteAccount} sub={copy.deleteBody} chevron={false}>
              <button
                type="button"
                className="button destructive compact"
                onClick={() => setDeleting(true)}
              >
                {commonCopy.delete}
              </button>
            </ListRow>
          </ListCard>
        </section>
      </div>
      <aside className="connections-full-aside">
        <MailTestBox account={account} onTested={changed} onEdit={onEdit} />
      </aside>
      {deleting && (
        <ConfirmDialog
          destructive
          title={copy.deleteTitle(account.name)}
          body={copy.deleteBody}
          confirmLabel={copy.deleteNow}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/mail/accounts/${encodeURIComponent(account.id)}`, "DELETE");
            setDeleting(false);
            changed();
            navigate(connectionsRoute("mail"), true);
          }}
        />
      )}
    </div>
  );
}

/**
 * Connections › Email accounts: the IMAP/SMTP mailboxes agents may be granted. The
 * list opens an account's full view (`item`); adding and editing use a dialog. The
 * password never comes back from the server, so no view can show it.
 */
export default function MailCategory({ shared, item, loading }) {
  const { mail, navigate } = shared;
  const accounts = Array.isArray(mail.data?.accounts) ? mail.data.accounts : null;
  const [form, setForm] = useState(null);
  const account = item ? (accounts || []).find((entry) => entry.id === item) : null;
  const missing = Boolean(item) && accounts !== null && !account;
  const flagged = problemRowIds(shared.problems, "mail");
  useEffect(() => {
    if (missing) navigate(connectionsRoute("mail"), true);
  }, [missing, navigate]);
  const changed = () => {
    mail.reload();
    shared.reloadAll();
  };
  const dialog = form && (
    <MailAccountForm
      account={form.account}
      close={() => setForm(null)}
      saved={() => {
        setForm(null);
        changed();
      }}
    />
  );
  const add = () => setForm({ account: null });
  const failed =
    accounts === null && mail.error ? (
      <div className="accounts-detail-error">
        <ErrorMessage error={mail.error} />
        <button type="button" className="button secondary" onClick={mail.reload}>
          {commonCopy.retry}
        </button>
      </div>
    ) : null;
  if (item)
    return (
      <>
        {account ? (
          <MailAccountView
            account={account}
            shared={shared}
            changed={changed}
            onEdit={() => setForm({ account })}
          />
        ) : (
          failed || loading
        )}
        {dialog}
      </>
    );
  return (
    <CategorySection
      title={areaCopy.sections.mail}
      count={accounts?.length ? String(accounts.length) : undefined}
      actions={
        accounts?.length ? (
          <button type="button" className="button primary compact" onClick={add}>
            {copy.add}
          </button>
        ) : null
      }
    >
      {accounts === null ? (
        failed || loading
      ) : accounts.length === 0 ? (
        <EmptyCategory
          icon="inbox"
          title={areaCopy.empty.mail.title}
          body={areaCopy.empty.mail.body}
          actions={[{ label: areaCopy.empty.mail.primary, onClick: add }]}
        />
      ) : (
        <ListCard label={areaCopy.sections.mail}>
          {accounts.map((entry) => {
            const route = connectionsRoute("mail", entry.id);
            // The mark follows GET /connections/problems, as the category's number does.
            const problem = rowHasProblem(flagged, entry.id);
            return (
              <ListRow
                key={entry.id}
                label={
                  problem ? (
                    <>
                      {entry.name}
                      <ProblemMarker />
                    </>
                  ) : (
                    entry.name
                  )
                }
                sub={entry.address}
                status={rowStatus(entry)}
                href={routePath(route)}
                onClick={() => navigate(route)}
                className={problem ? "has-problem" : ""}
              />
            );
          })}
        </ListCard>
      )}
      {dialog}
    </CategorySection>
  );
}
