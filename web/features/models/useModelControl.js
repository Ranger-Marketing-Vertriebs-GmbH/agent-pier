import { modelRequest } from "./model-request.js";
import { modelReadError } from "./model-read-error.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { modelControlCopy as copy } from "../../lib/i18n/messages/models.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, useCallback } from "react";
const emptyState = {
  currentModel: null,
  currentSource: null,
  picker: null,
  notice: null,
  pending: false,
};
export default function useModelControl({ session, active, request, onPendingChange }) {
  const [state, setState] = useState(emptyState);
  const [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const mutationAbort = useRef(null);
  const [readError, setReadError] = useState("");
  const [availableHeight, setAvailableHeight] = useState(540);
  const generation = useRef(0),
    mounted = useRef(false),
    mutating = useRef(false);
  const requestRef = useRef(request),
    pendingCallback = useRef(onPendingChange);
  const trigger = useRef(null),
    panel = useRef(null),
    panelId = useId();
  requestRef.current = request;
  pendingCallback.current = onPendingChange;
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  const picker = state.picker;
  const pickerToken = picker?.token;
  const blocked = reconciling || busy || Boolean(picker) || Boolean(state.pending);
  const visible = expanded || Boolean(picker) || Boolean(state.pending);
  useLayoutEffect(() => {
    if (!active || !visible) return;
    const control = trigger.current?.closest(".model-control");
    const chat = control?.closest(".chat-layout");
    if (!control || !chat) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const top = Math.max(viewport?.offsetTop || 0, chat.getBoundingClientRect().top);
      setAvailableHeight(
        Math.max(0, Math.floor(control.getBoundingClientRect().top - top - 17)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(control);
    observer.observe(chat);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [active, visible]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationAbort.current?.abort();
      invalidateRequests();
      pendingCallback.current?.(false);
    };
  }, [invalidateRequests]);
  useEffect(() => {
    generation.current++;
    mutationAbort.current?.abort();
    mutationAbort.current = null;
    mutating.current = false;
    heldPush.current = null;
    setReconciling(false);
    setState(emptyState);
    setBusy(false);
    setExpanded(false);
    setError("");
    setReadError("");
    setQuery("");
  }, [session.id]);
  useEffect(() => {
    pendingCallback.current?.(blocked);
  }, [blocked, onPendingChange]);
  // The model state is pushed (the server samples the screen once per session); a
  // change of this tab's own is shown from its answer, and a push that arrives during
  // it is held and applied once the change settles. A failed or hung read on the server
  // arrives as `error` beside the last model read.
  const live = useLiveTopic(active ? `session.models:${session.id}` : null);
  const refreshLive = useRef(live.refresh);
  refreshLive.current = live.refresh;
  const heldPush = useRef(null);
  const applyPushed = useCallback((data) => {
    const { error: failure, ...model } = data;
    setReconciling(false);
    setReadError(failure ? modelReadError(failure) : "");
    if (!failure || Object.keys(model).length) setState({ ...emptyState, ...model });
  }, []);
  useEffect(() => {
    if (!live.data) return;
    if (mutating.current) heldPush.current = live.data;
    else applyPushed(live.data);
  }, [live.data, applyPushed]);
  useEffect(() => {
    if (!live.error || mutating.current) return;
    setReconciling(false);
    setReadError(live.error);
  }, [live.error]);
  useEffect(() => {
    if (!active || !pickerToken) return;
    const selected = panel.current?.querySelector('[data-selected="true"]');
    (selected || panel.current?.querySelector(".model-option"))?.focus();
  }, [active, pickerToken]);
  async function mutate(action, body = {}) {
    const restartRequired =
      state.modelChangeRequiresRestart ||
      state.configuration?.modelChangeRequiresRestart ||
      session.provider?.modelChangeRequiresRestart;
    if (
      session.pipeline?.headless ||
      mutating.current ||
      (restartRequired && action !== "cancel")
    )
      return;
    const version = ++generation.current;
    const controller = new AbortController();
    mutationAbort.current = controller;
    mutating.current = true;
    setBusy(true);
    setError("");
    setExpanded(true);
    try {
      const result = await modelRequest(
        requestRef.current,
        `/sessions/${session.id}/models/${action}`,
        "POST",
        body,
        copy.changeTimeout,
        controller.signal,
      );
      if (!mounted.current || version !== generation.current) return;
      const next = {
        ...emptyState,
        ...result,
      };
      setReadError("");
      setState(next);
      if (!next.picker && !next.pending && (action === "cancel" || action === "select")) {
        setExpanded(false);
        setQuery("");
        trigger.current?.focus();
      }
    } catch (err) {
      if (mounted.current && version === generation.current) {
        if (err.code === "MODEL_REQUEST_TIMEOUT") {
          setReconciling(true);
          setReadError(err.message);
          // The screen is read again over REST; its answer ends the reconciling.
          refreshLive.current().then((data) => {
            if (!data && mounted.current) setReconciling(false);
          });
        } else setError(err.message);
      }
    } finally {
      if (mounted.current && version === generation.current) {
        mutationAbort.current = null;
        mutating.current = false;
        setBusy(false);
        const held = heldPush.current;
        heldPush.current = null;
        if (held) applyPushed(held);
      }
    }
  }
  function cancel() {
    if (busy) return;
    if (picker?.token)
      mutate("cancel", {
        token: picker.token,
      });
    else if (!state.pending) {
      setExpanded(false);
      trigger.current?.focus();
    }
  }
  return {
    state,
    trigger,
    visible,
    panelId,
    busy,
    picker,
    setExpanded,
    mutate,
    error: error || readError,
    panel,
    availableHeight,
    cancel,
    query,
    setQuery,
  };
}
