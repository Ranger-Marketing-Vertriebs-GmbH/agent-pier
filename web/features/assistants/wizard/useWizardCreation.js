import { useCallback, useRef, useState } from "react";
import api from "../../../lib/api.js";
import { getLanguage } from "../../../lib/i18n/index.js";
import { ownerUsersApi } from "../../users/owner-users-api.js";
import { assistantApi } from "../assistant-api.js";
import { routineApi } from "../routine-api.js";
import { creationPlan, runCreation } from "./wizard-creation.js";

// The endpoints each step uses: the same ones as the agent's settings tabs.
const endpoints = {
  create: assistantApi.create,
  createUserAgent: ownerUsersApi.createAgent,
  update: assistantApi.update,
  saveWork: assistantApi.saveWork,
  createChannel: assistantApi.createChannel,
  createRoutine: routineApi.create,
  // Each step reads the revision it sends right before sending.
  revision: async (id, kind) => {
    if (kind === "access")
      return (await api(`/assistants/${encodeURIComponent(id)}/access`)).revision;
    if (kind === "team")
      return (await api("/assistant-teams"))?.policies?.[id]?.revision ?? 1;
    const { assistants = [] } = await assistantApi.list();
    return assistants.find((a) => a.id === id)?.revision;
  },
};

/**
 * The creation of one wizard draft: runs its plan once, keeps every step's result,
 * repeats a failed step only on "Erneut", and hands server confirmations (shell,
 * stdio, restart) to the owner as `confirmation`.
 */
export default function useWizardCreation() {
  const [state, setState] = useState({ plan: [], results: {}, agent: null });
  const [running, setRunning] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const routineRequestId = useRef(crypto.randomUUID());
  const current = useRef(state);
  current.current = state;
  const ask = (request) =>
    new Promise((resolve) => {
      setConfirmation({
        ...request,
        confirm: () => {
          setConfirmation(null);
          resolve(true);
        },
        cancel: () => {
          setConfirmation(null);
          resolve(false);
        },
      });
    });
  const run = useCallback(async (d, only = null) => {
    setRunning(true);
    const plan = only ? current.current.plan : creationPlan(d);
    try {
      const outcome = await runCreation({
        plan,
        d,
        api: endpoints,
        ask,
        env: {
          origin: window.location.origin,
          language: getLanguage(),
          routineRequestId: routineRequestId.current,
        },
        results: only ? current.current.results : {},
        agent: current.current.agent,
        only,
        onProgress: (progress) => setState({ plan, ...progress }),
      });
      setState({ plan, ...outcome });
      return outcome;
    } finally {
      setRunning(false);
    }
  }, []);
  const reset = useCallback(() => setState({ plan: [], results: {}, agent: null }), []);
  return {
    ...state,
    running,
    confirmation,
    start: (d) => run(d),
    retry: (d, step) => run(d, step),
    reset,
  };
}
