import api from "../../../lib/api.js";

/** The draft fields of a native CLI account; `provider` null means "unchanged". */
export function nativeAccountValues(account, tools = []) {
  return {
    name: account?.name || "",
    tool: account?.tool || tools.find((item) => item.id !== "shell")?.id || "",
    apiKey: "",
    removeApiKey: false,
    provider: null,
  };
}

/** The body AccountDialog sent. */
export function nativeAccountBody(values, account) {
  const body = { name: values.name.trim() };
  if (!account) body.tool = values.tool;
  if (values.apiKey) body.apiKey = values.apiKey;
  if (values.removeApiKey) body.removeApiKey = true;
  if (values.provider) {
    if (values.provider.selection) body.provider = values.provider.selection;
    else if (account?.provider) body.provider = null;
  }
  return body;
}

/** A stored key belongs to the old provider: switching needs a new one or removal. */
export const keyChangeRequired = (values, account, providerId) =>
  Boolean(
    account?.hasSecret &&
    (account.provider?.id || "") !== providerId &&
    !values.apiKey.trim() &&
    !values.removeApiKey,
  );

export function nativeAccountStep({ account, label, request = api, saved }) {
  return {
    id: "account",
    label,
    async run({ values }) {
      const result = await request(
        account ? `/accounts/${account.id}` : "/accounts",
        account ? "PATCH" : "POST",
        nativeAccountBody(values, account),
      );
      await saved(result);
      return result;
    },
  };
}
