import { useCallback, useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";

/**
 * What the hub lists besides /api/state: the central MCP servers (always) and, with
 * agents, the ChatGPT accounts, speech, web search and PDF model settings. Each source keeps its
 * own load error. The newest load of the ChatGPT accounts wins over an older one still
 * in flight; they load again whenever the agent runtime becomes ready or stops being
 * ready, so their status is never stale.
 */
export default function useAccountsData({ agentsEnabled, runtimeReady = false }) {
  const [mcpServers, setMcpServers] = useState(null);
  const [mcpError, setMcpError] = useState("");
  const [mcpGeneration, setMcpGeneration] = useState(0);
  const [chatgpt, setChatgpt] = useState(null);
  const [chatgptError, setChatgptError] = useState("");
  const [speech, setSpeech] = useState(null);
  const [speechError, setSpeechError] = useState("");
  const [webSearch, setWebSearch] = useState(null);
  const [webSearchError, setWebSearchError] = useState("");
  const [pdfModel, setPdfModel] = useState(null);
  const [pdfModelError, setPdfModelError] = useState("");
  const chatgptLoad = useRef(null);
  // Resolves to the fresh list (undefined after a failed load).
  const reloadMcp = useCallback(async () => {
    try {
      const list = await assistantApi.mcpServers();
      setMcpServers(list);
      setMcpError("");
      return list;
    } catch (error) {
      setMcpError(error.message);
    } finally {
      // The CLI finds load again with every reload, also after a failed one.
      setMcpGeneration((value) => value + 1);
    }
  }, []);
  useEffect(() => {
    reloadMcp();
  }, [reloadMcp]);
  // Rejects after a failed load, so a detail action can report it too.
  const reloadChatgpt = useCallback(async () => {
    const load = {};
    chatgptLoad.current = load;
    try {
      const result = await assistantApi.accounts();
      if (chatgptLoad.current === load) {
        setChatgpt(result.accounts);
        setChatgptError("");
      }
    } catch (error) {
      if (chatgptLoad.current === load) setChatgptError(error.message);
      throw error;
    }
  }, []);
  // A detail re-reads its settings after a 409 so "Overwrite anyway" sends the newer
  // revision.
  const reloadSpeech = useCallback(async () => {
    try {
      const next = await assistantApi.speech();
      setSpeech(next);
      setSpeechError("");
      return next;
    } catch (error) {
      setSpeechError(error.message);
    }
  }, []);
  const reloadWebSearch = useCallback(async () => {
    try {
      const next = await assistantApi.webSearch();
      setWebSearch(next);
      setWebSearchError("");
      return next;
    } catch (error) {
      setWebSearchError(error.message);
    }
  }, []);
  const reloadPdfModel = useCallback(async () => {
    try {
      const next = await assistantApi.pdfModel();
      setPdfModel(next);
      setPdfModelError("");
      return next;
    } catch (error) {
      setPdfModelError(error.message);
    }
  }, []);
  useEffect(() => {
    if (!agentsEnabled) return undefined;
    const controller = new AbortController();
    const load = (read, set, fail) =>
      read(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) set(next);
        })
        .catch((error) => {
          if (!controller.signal.aborted) fail(error.message);
        });
    load(assistantApi.speech, setSpeech, setSpeechError);
    load(assistantApi.webSearch, setWebSearch, setWebSearchError);
    load(assistantApi.pdfModel, setPdfModel, setPdfModelError);
    return () => controller.abort();
  }, [agentsEnabled]);
  useEffect(() => {
    if (!agentsEnabled) return undefined;
    reloadChatgpt().catch(() => {});
    return () => {
      chatgptLoad.current = null;
    };
  }, [agentsEnabled, runtimeReady, reloadChatgpt]);
  return {
    mcpServers,
    mcpError,
    mcpGeneration,
    reloadMcp,
    chatgpt,
    chatgptError,
    reloadChatgpt,
    speech,
    speechError,
    setSpeech,
    reloadSpeech,
    webSearch,
    webSearchError,
    setWebSearch,
    reloadWebSearch,
    pdfModel,
    pdfModelError,
    setPdfModel,
    reloadPdfModel,
  };
}
