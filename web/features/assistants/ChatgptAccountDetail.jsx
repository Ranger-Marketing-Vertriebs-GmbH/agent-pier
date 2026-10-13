import React, { useCallback, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail from "../accounts/AccountDetail.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { assistantApi } from "./assistant-api.js";
import ChatgptOfflineNote from "./ChatgptOfflineNote.jsx";
import useAssistants from "./useAssistants.js";
import useChatgptLogin from "./useChatgptLogin.js";

/** One ChatGPT account of the agents: status, check, disconnect. */
export default function ChatgptAccountDetail({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
}) {
  const account = entry.record;
  const { runtime, refresh } = useAssistants();
  const ready = runtime.availability === "ready";
  const { reloadChatgpt } = data;
  const reload = useCallback(async () => {
    await reloadChatgpt();
    await refresh();
  }, [reloadChatgpt, refresh]);
  // A device login still waiting blocks both actions, as before.
  const { active, busy, error, perform } = useChatgptLogin({ reload });
  const [check, setCheck] = useState("");
  const blocked = !ready || busy || active;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        <button
          type="button"
          className="button secondary danger-text"
          disabled={blocked}
          onClick={() =>
            perform(async () => {
              await assistantApi.logoutAccount(account.id);
              await reload();
              navigate(itemRoute("models"), true);
            })
          }
        >
          {copy.accountDisconnect}
        </button>
      }
    >
      <ErrorMessage error={error} />
      {!ready && <ChatgptOfflineNote navigate={navigate} />}
      <ListCard>
        <ListRow
          label={copy.accountsTitle}
          value={
            copy.accountStatus[ready ? account.status : "offline"] ||
            copy.accountStatus.unknown
          }
        />
      </ListCard>
      {check && (
        <p role="status" className="accounts-note">
          {check === "ok" ? copy.accountVerified : copy.accountCheckFailed}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={blocked}
        onClick={() =>
          perform(async () => {
            const result = await assistantApi.checkAccount(account.id);
            setCheck(result.status);
            await reload();
          })
        }
      >
        {copy.accountCheck}
      </button>
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
