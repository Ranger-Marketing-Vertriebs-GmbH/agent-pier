import { validModelId, withOpenaiUrl } from "./endpoint-draft.js";

// …/openai/deployments/<name>/<operation>?api-version=…, as the Azure portal and
// Azure AI Foundry show a deployment's target URI.
const DEPLOYMENT_PATH = /^\/openai\/deployments\/([^/]+)(?:\/|$)/;

/**
 * The base URL and deployment name of a pasted Azure deployment URL, or null for any
 * other address. The v1 API names the deployment as model under <origin>/openai/v1.
 */
export function parseAzureDeploymentUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol)) return null;
  const match = DEPLOYMENT_PATH.exec(url.pathname);
  if (!match) return null;
  let deployment;
  try {
    deployment = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!validModelId(deployment) || deployment.includes("/")) return null;
  return { openaiBaseUrl: `${url.origin}/openai/v1`, deployment };
}

/**
 * Sets the OpenAI base URL as typed or pasted. A pasted Azure deployment URL becomes its
 * base URL, and the deployment is offered as a manual model that still needs its
 * context size; `pastedDeployment` names it for the form's note.
 */
export function withPastedUrl(draft, value) {
  const { pastedDeployment: _previous, ...rest } = draft;
  const parsed = parseAzureDeploymentUrl(value);
  if (!parsed) return withOpenaiUrl(rest, value);
  const next = withOpenaiUrl(rest, parsed.openaiBaseUrl);
  const known = next.models.some((model) => model.modelId === parsed.deployment);
  return {
    ...next,
    // Azure has no Anthropic Messages API: never derive one from the Azure address.
    ...(rest.anthropicAuto !== false ? { anthropicBaseUrl: "" } : {}),
    models: known
      ? next.models
      : [
          ...next.models,
          {
            modelId: parsed.deployment,
            label: parsed.deployment,
            contextTokens: null,
            outputTokens: null,
            source: "manual",
            contextEdited: true,
            images: null,
          },
        ],
    pastedDeployment: parsed.deployment,
  };
}
