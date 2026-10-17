import { useEffect, useId, useMemo, useRef, useState } from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { accountItemTitle, itemRoute } from "../../accounts/accounts-items.js";
import useAccountDraft from "../../accounts/useAccountDraft.js";
import { savedNotice } from "../mcp-notices.js";
import { refusalField } from "../mcp-package-labels.js";
import { mcpServerStep, mcpServerValues } from "../mcp-server-save.js";
import { timeoutRefusal } from "../mcp-timeouts.js";

const valueReference = (error) => error?.code === "MCP_SERVER_VALUE_REFERENCE";
const nameRefusal = (error) =>
  ["mcpServers.nameTaken", "mcpServers.invalidName"].includes(error?.messageKey);

/**
 * The draft of one saved server's edit step; a save returns to the overview. It saves
 * through `mcpServerStep`, so a changed command, arguments, directory or env still asks
 * "Run a local command?" and attaching a package still shows the install confirmation.
 */
export default function useMcpServerForm({ entry, data, notifyMcp, navigate }) {
  const server = entry.record;
  const formId = useId();
  const formRef = useRef(null);
  // Status refreshes do not change the definition; only a new revision does.
  const signature = JSON.stringify([server.id, server.revision, server.clis]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => mcpServerValues(server), [signature]);
  const [fieldError, setFieldError] = useState(null);
  const consumed = useRef(null);
  // The program the install confirmation chose; confirm() itself takes no arguments.
  const programChoice = useRef(null);
  const leave = useRef(null);
  const { reloadMcp } = data;
  // After a 409 and for Reload / Overwrite the draft reads the newer revision itself.
  const refresh = async () => {
    const fresh = (await reloadMcp())?.find((item) => item.id === server.id);
    return fresh
      ? { server: mcpServerValues(fresh), revisions: { mcp: fresh.revision } }
      : undefined;
  };
  const form = useAccountDraft({
    server: initial,
    revisions: { mcp: server.revision },
    refresh,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      mcpServerStep({
        server,
        label: mcpWizardCopy.edit.save,
        chosenProgram: () => programChoice.current,
        saved: async (result) => {
          notifyMcp(savedNotice(result) || mcpWizardCopy.done.changesSaved);
          await reloadMcp();
          // The draft is dropped first, so leaving never asks about saved changes.
          leave.current?.(navigate, itemRoute("mcp-servers", server.id));
        },
      }),
    ],
  });
  leave.current = form.leave;
  const { draft } = form;
  // A refused value or name belongs to its field, not to the bar.
  useEffect(() => {
    const failure = draft.outcome?.error;
    // The registry is read when the refusal arrives.
    const field = refusalField(failure, draft.values.registry) ?? timeoutRefusal(failure);
    if (field || nameRefusal(failure)) {
      consumed.current = draft.outcome;
      setFieldError({ field: field || "name", text: failure.message });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  return {
    server,
    form,
    draft,
    barDraft,
    set,
    fieldError,
    formId,
    formRef,
    programChoice,
  };
}
