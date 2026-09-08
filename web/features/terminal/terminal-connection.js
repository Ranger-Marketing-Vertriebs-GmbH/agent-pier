// Only the current socket may update the terminal. Native input is never buffered.
export function connectTerminal({
  createSocket,
  onOpen,
  onMessage,
  onState,
  document = globalThis.document,
  window = globalThis.window,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let socket, retryTimer, wakeTimer;
  let disposed = false,
    retries = 0;
  const visible = () => document.visibilityState !== "hidden";
  const connect = () => {
    if (disposed || !visible()) return;
    clearTimer(retryTimer);
    const previous = socket;
    socket = undefined;
    previous?.close();
    onState("connecting");
    const current = createSocket();
    socket = current;
    const active = () => !disposed && socket === current;
    current.onopen = () => {
      if (!active()) return;
      retries = 0;
      onState("connected");
      onOpen();
    };
    current.onmessage = (event) => {
      if (active()) onMessage(event);
    };
    current.onclose = () => {
      if (!active()) return;
      socket = undefined;
      onState("disconnected");
      retryTimer = setTimer(connect, Math.min(1000 * 2 ** retries++, 10000));
    };
    current.onerror = () => {
      if (active()) onState("disconnected");
    };
  };
  const wake = () => {
    if (disposed || !visible()) return;
    clearTimer(wakeTimer);
    wakeTimer = setTimer(() => {
      wakeTimer = undefined;
      if (!visible()) return;
      connect();
    }, 100);
  };
  const visibility = () => {
    if (visible()) wake();
    else {
      clearTimer(wakeTimer);
      clearTimer(retryTimer);
    }
  };
  const pageshow = (event) => {
    if (event.persisted) {
      wake();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", pageshow);
  connect();
  return {
    send(data) {
      if (disposed || socket?.readyState !== 1) return false;
      try {
        socket.send(data);
        return true;
      } catch {
        wake();
        return false;
      }
    },
    dispose() {
      disposed = true;
      clearTimer(retryTimer);
      clearTimer(wakeTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", pageshow);
      socket?.close();
      socket = undefined;
    },
  };
}
