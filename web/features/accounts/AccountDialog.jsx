import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { connectionCopy } from "../../lib/i18n/de/connections.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { accountDialogCopy as copy } from "../../lib/i18n/de/accounts.js";
import React, { useState } from "react";
import { providerCopy } from "../../lib/i18n/de/providers.js";
import useAccountProvider from "../providers/useAccountProvider.js";
import ProviderFields from "../providers/ProviderFields.jsx";
import api from "../../lib/api.js";
import Icon from "../../components/Icon.jsx";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
export default function AccountDialog({ account, tools, close, saved }) {
  const [tool, setTool] = useState(
    account?.tool || tools.find((item) => item.id !== "shell")?.id || "",
  );
  const [apiKey, setApiKey] = useState("");
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const provider = useAccountProvider(account, tool);
  const keyChangeRequired =
    account?.hasSecret &&
    (account.provider?.id || "") !== provider.providerId &&
    !apiKey.trim() &&
    !removeApiKey;
  return (
    <Modal title={account ? commonCopy.editAccount : commonCopy.addAccount} close={close}>
      <AsyncForm
        close={close}
        disabled={!provider.ready || keyChangeRequired}
        button={account ? commonCopy.save : commonCopy.createAccount}
        submit={async (data) => {
          const body = {
            name: data.get("name").trim(),
          };
          if (!account) body.tool = tool;
          if (apiKey) body.apiKey = apiKey;
          if (removeApiKey) body.removeApiKey = true;
          if (!account || provider.changed) {
            if (provider.selection) body.provider = provider.selection;
            else if (account?.provider) body.provider = null;
          }
          await api(
            account ? `/accounts/${account.id}` : "/accounts",
            account ? "PATCH" : "POST",
            body,
          );
          await saved();
          close();
        }}
      >
        <p className="field-description">{copy.profileIsolationDescription}</p>
        <label>
          {commonCopy.accountName}
          <input
            name="name"
            required
            autoFocus
            maxLength={100}
            defaultValue={account?.name || ""}
            placeholder={copy.accountNamePlaceholder}
          />
        </label>
        {!account && (
          <label>
            {copy.toolLabel}
            <AnchoredSelect
              label={copy.toolLabel}
              value={tool}
              onChange={setTool}
              options={tools
                .filter((item) => item.id !== "shell")
                .map((item) => ({
                  value: item.id,
                  label: item.name + (!item.installed ? copy.uninstalledToolSuffix : ""),
                }))}
            />
          </label>
        )}
        {account?.provider && (
          <>
            <p className="field-description">{connectionCopy.legacyHelp}</p>
            <ProviderFields controller={provider} tool={tool} />
          </>
        )}
        {account?.kind !== "local" && (
          <label>
            {copy.apiKeyLabel}
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={removeApiKey}
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={
                account?.hasSecret ? copy.savedKeyPlaceholder : copy.nativeKeyPlaceholder
              }
            />
          </label>
        )}
        {account?.hasSecret && (
          <label className="provider-check">
            <input
              type="checkbox"
              checked={removeApiKey}
              onChange={(event) => {
                setRemoveApiKey(event.target.checked);
                if (event.target.checked) setApiKey("");
              }}
            />
            <span>{providerCopy.keyRemove}</span>
          </label>
        )}
        {keyChangeRequired && (
          <p className="field-description">{providerCopy.switchKey}</p>
        )}
        <p className="field-description">
          {provider.providerId ? providerCopy.keyHelp : copy.nativeAuthenticationHelp}
        </p>
        <div className="form-note">
          <Icon name="shield" />
          {copy.formNote}
        </div>
      </AsyncForm>
    </Modal>
  );
}
