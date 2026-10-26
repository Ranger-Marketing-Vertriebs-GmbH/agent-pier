import { useEffect, useState } from "react";
import api from "../../../lib/api.js";
import { assistantApi } from "../assistant-api.js";

const accessPath = (id) => `/assistants/${encodeURIComponent(id)}/access`;

/**
 * What the All agents tab summarises beyond the agent list, read once per change of
 * the listed agents: each agent's access record (for its pills), which agents have a
 * Telegram channel, whether web search is set up and whether an OpenClaw update is
 * ready. A read that fails stays unknown (null) and shows nothing.
 */
export default function useHubSummaries(agentIds, enabled) {
  const [policies, setPolicies] = useState({});
  const [telegram, setTelegram] = useState(null);
  const [webSearchReady, setWebSearchReady] = useState(null);
  const [updateReady, setUpdateReady] = useState(null);
  const key = agentIds.join(",");
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    for (const id of key ? key.split(",") : [])
      api(accessPath(id), "GET", undefined, controller.signal)
        .then((policy) => live() && setPolicies((old) => ({ ...old, [id]: policy })))
        .catch(() => {});
    assistantApi
      .channels()
      .then(
        (result) =>
          live() &&
          setTelegram(new Set((result.channels || []).map((c) => c.assistantId))),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [key, enabled]);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    assistantApi
      .webSearch(controller.signal)
      .then((search) => live() && setWebSearchReady(search?.ready !== false))
      .catch(() => {});
    api("/assistant-runtime/updates", "GET", undefined, controller.signal)
      .then(
        (status) =>
          live() &&
          setUpdateReady(status?.updateAvailable === true || status?.candidateReady),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return { policies, telegram, webSearchReady, updateReady: updateReady === true };
}
