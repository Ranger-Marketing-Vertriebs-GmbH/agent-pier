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
  const blocked = busy || Boolean(picker) || Boolean(state.pending);
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
      invalidateRequests();
      pendingCallback.current?.(false);
    };
  }, [invalidateRequests]);
  useEffect(() => {
    generation.current++;
    mutating.current = false;
    setState(emptyState);
    setBusy(false);
    setExpanded(false);
    setError("");
    setQuery("");
  }, [session.id]);
  useEffect(() => {
    pendingCallback.current?.(blocked);
  }, [blocked, onPendingChange]);
  useEffect(() => {
    if (!active) return;
    let alive = true,
      timer;
    const poll = async () => {
      const version = generation.current;
      if (!mutating.current) {
        try {
          const result = await requestRef.current(`/sessions/${session.id}/models`);
          if (alive && version === generation.current && !mutating.current)
            setState({
              ...emptyState,
              ...result,
            });
        } catch (err) {
          if (alive && version === generation.current && !mutating.current)
            setError((current) => current || err.message);
        }
      }
      if (alive) timer = setTimeout(poll, 3000);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active, session.id]);
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
    mutating.current = true;
    setBusy(true);
    setError("");
    setExpanded(true);
    try {
      const result = await requestRef.current(
        `/sessions/${session.id}/models/${action}`,
        "POST",
        body,
      );
      if (!mounted.current || version !== generation.current) return;
      const next = {
        ...emptyState,
        ...result,
      };
      setState(next);
      if (!next.picker && !next.pending && (action === "cancel" || action === "select")) {
        setExpanded(false);
        setQuery("");
        trigger.current?.focus();
      }
    } catch (err) {
      if (mounted.current && version === generation.current) setError(err.message);
    } finally {
      if (mounted.current && version === generation.current) {
        mutating.current = false;
        setBusy(false);
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
    error,
    panel,
    availableHeight,
    cancel,
    query,
    setQuery,
  };
}
