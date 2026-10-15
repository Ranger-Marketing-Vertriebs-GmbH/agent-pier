import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import useCreatedRedirect from "../accounts/useCreatedRedirect.js";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { OAuthSwitchConfirmation } from "./McpAuthFields.jsx";
import McpFeedback from "./McpFeedback.jsx";
import McpPackageConfirmation from "./McpPackageConfirmation.jsx";
import McpPackagePanel from "./McpPackagePanel.jsx";
import McpRemoveConfirmation from "./McpRemoveConfirmation.jsx";
import McpServerFields from "./McpServerFields.jsx";
import McpServerInfo from "./McpServerInfo.jsx";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { savedNotice } from "./mcp-notices.js";
import { mcpServerStep, mcpServerValues } from "./mcp-server-save.js";
import "./mcp-servers.css";
import "./mcp-cli.css";

const valueReference = (error) => error?.code === "MCP_SERVER_VALUE_REFERENCE";
// A preview refusing the dependency constraints belongs to that field.
const refusedConstraints = (error) =>
  error?.messageKey === "mcpPackages.invalidConstraints";

/** One central MCP server: create (item=new) or view, edit, log in, remove. */
export default function McpServerDetail({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
  oauth,
  mcpNotice,
  notifyMcp,
}) {
  const server = entry.kind === "mcp-server" ? entry.record : null;
  const formId = useId();
  const formRef = useRef(null);
  // Status refreshes do not change the definition; only a new revision does.
  const signature = JSON.stringify([server?.id, server?.revision, server?.clis]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => mcpServerValues(server), [signature]);
  const [created, setCreated] = useState(null);
  const [fieldError, setFieldError] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const consumed = useRef(null);
  // The program the install confirmation chose; confirm() itself takes no arguments.
  const programChoice = useRef(null);
  const { reloadMcp } = data;
  // After a 409 and for Reload / Overwrite the draft reads the newer revision itself,
  // so "Overwrite anyway" never sends the stale one.
  const refresh = async () => {
    const fresh = (await reloadMcp())?.find((item) => item.id === server.id);
    return fresh
      ? { server: mcpServerValues(fresh), revisions: { mcp: fresh.revision } }
      : undefined;
  };
  const form = useAccountDraft({
    server: initial,
    revisions: server ? { mcp: server.revision } : {},
    refresh: server ? refresh : undefined,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      mcpServerStep({
        server,
        label: copy.save,
        chosenProgram: () => programChoice.current,
        saved: async (result) => {
          notifyMcp(savedNotice(result));
          await reloadMcp();
          if (!server) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  useCreatedRedirect({ created, draft, navigate, section: "mcp-servers" });
  // A refused value belongs to its field, not to the bar.
  useEffect(() => {
    const failure = draft.outcome?.error;
    if (refusedConstraints(failure)) {
      consumed.current = draft.outcome;
      setFieldError({ field: "packageConstraints", text: failure.message });
      return;
    }
    if (!valueReference(failure)) return;
    consumed.current = draft.outcome;
    setFieldError({
      field: failure.field,
      names: failure.names || [],
      text: failure.names?.length
        ? `${failure.message} ${copy.referenceNames(failure.names.join(", "))}`
        : failure.message,
    });
  }, [draft.outcome]);
  const barDraft =
    draft.outcome && draft.outcome === consumed.current
      ? { ...draft, outcome: null }
      : draft;
  // Any change withdraws an open question; it was about the previous state.
  const set = (key) => (value) => {
    draft.confirmation?.cancel();
    if (fieldError?.field === key) setFieldError(null);
    draft.set(key, value);
  };
  async function remove() {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      notifyMcp(savedNotice(result));
      await reloadMcp();
      form.leave(navigate, itemRoute("mcp-servers"));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  const confirmation = draft.confirmation;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        server &&
        (removing ? (
          <McpRemoveConfirmation
            server={server}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setRemoving(false)}
          />
        ) : (
          <button
            type="button"
            className="button secondary danger-text"
            aria-label={copy.removeNamed(server.name)}
            data-focus-key={`remove-${server.id}`}
            onClick={() => setRemoving(true)}
          >
            {copy.remove}
          </button>
        ))
      }
      bar={
        <AccountSaveBar
          form={form}
          draft={barDraft}
          formRef={formRef}
          saveLabel={copy.save}
          saveFocusKey="mcp-form-save"
        />
      }
    >
      {server && (
        <McpServerInfo
          server={server}
          agentsEnabled={agentsEnabled}
          oauth={oauth}
          reload={data.reloadMcp}
        />
      )}
      {server?.source && <McpPackagePanel server={server} onChanged={reloadMcp} />}
      <McpFeedback oauth={oauth} notice={mcpNotice} />
      <ErrorMessage error={error} />
      <form
        id={formId}
        ref={formRef}
        className="accounts-detail-group"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset disabled={draft.saving && !confirmation}>
          <McpServerFields
            formId={formId}
            values={draft.values}
            server={server}
            set={set}
            fieldError={fieldError}
          />
        </fieldset>
      </form>
      {confirmation?.kind === "oauthSwitch" && (
        <OAuthSwitchConfirmation
          names={server.headerNames}
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {confirmation?.kind === "package" && (
        <McpPackageConfirmation
          preview={confirmation.data.preview}
          allowScripts={draft.values.allowScripts}
          returnKey="mcp-form-save"
          onConfirm={(program) => {
            programChoice.current = program ?? null;
            confirmation.confirm();
          }}
          onCancel={confirmation.cancel}
        />
      )}
      {confirmation?.kind === "stdio" && (
        <StdioConfirmation
          returnKey="mcp-form-save"
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {confirmation?.kind === "cliStdio" && (
        <StdioConfirmation
          cli
          returnKey="mcp-form-save"
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {server && (
        <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
      )}
    </AccountDetail>
  );
}
