import "@xterm/xterm/css/xterm.css";

import { terminalViewCopy as copy } from "../../lib/i18n/messages/terminal.js";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { connectTerminal } from "./terminal-connection.js";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { terminalKey } from "./terminal-keyboard.js";

export default function useTerminalConnection({
  session,
  mode,
  sendRef,
  focusRef,
  onConnection,
  request,
}) {
  const container = useRef(null),
    terminalRef = useRef(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      connection;
    const terminal = new XTerminal({
      cursorBlink: !session.pipeline?.headless,
      disableStdin: Boolean(session.pipeline?.headless),
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 10000,
      // A CLI that enables mouse tracking (Claude Code through tmux) consumes drag
      // events. xterm then selects text only through shouldForceSelection, which on
      // macOS additionally requires this option; without it the platform has no way
      // to select at all. Other platforms already fall back to Shift.
      macOptionClickForcesSelection: true,
    });
    // xterm implements no OSC 52 handler, so a CLI's copy request is parsed and
    // dropped. Clipboard writes need transient activation; the keystroke that
    // triggered the sequence supplies it, since the reply arrives within its window.
    terminal.parser.registerOscHandler(52, (data) => {
      const encoded = data.slice(data.indexOf(";") + 1);
      // "?" asks to read the clipboard. Answering would hand it to the CLI.
      if (encoded === "?") return true;
      try {
        const text = new TextDecoder().decode(
          Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        );
        // Absent over plain HTTP, where the API is unavailable rather than failing.
        const written = navigator.clipboard?.writeText(text);
        if (written) written.catch(() => setError(copy.clipboard));
        else setError(copy.clipboard);
      } catch {
        setError(copy.clipboard);
      }
      return true;
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container.current);
    terminalRef.current = terminal;
    focusRef.current = () => terminal.focus();
    const resize = () => {
      if (disposed || !container.current?.clientWidth || !container.current?.clientHeight)
        return;
      try {
        fit.fit();
        if (terminal.cols > 0 && terminal.rows > 0)
          connection?.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
      } catch {}
    };
    const input = (data) => {
      if (session.pipeline?.headless) return false;
      if (connection?.send(JSON.stringify({ type: "input", data }))) {
        terminal.focus();
        return true;
      }
      setError(copy.input);
      return false;
    };
    sendRef.current = input;
    terminal.attachCustomKeyEventHandler((event) => {
      const data = terminalKey(event);
      if (!data) return true;
      event.preventDefault();
      input(data);
      return false;
    });
    const dataListener = terminal.onData(input);
    resize();
    if (session.status === "running") {
      connection = connectTerminal({
        createSocket: () =>
          new WebSocket(
            `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(session.id)}/terminal`,
          ),
        onState: onConnection,
        onOpen: () => {
          terminal.reset();
          setError("");
          resize();
        },
        onMessage: (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "output") terminal.write(message.data);
            if (message.type === "error") setError(message.message);
            if (message.type === "status" && message.status !== "running")
              onConnection("ended");
          } catch {
            setError(copy.connect);
          }
        },
      });
    } else {
      onConnection("ended");
      request(`/sessions/${session.id}/screen`)
        .then((data) => {
          if (!disposed) terminal.write(data.text.replace(/\r?\n/g, "\r\n"));
        })
        .catch((err) => {
          if (!disposed) setError(err.message);
        });
    }
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    return () => {
      disposed = true;

      observer.disconnect();
      dataListener.dispose();
      connection?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      sendRef.current = null;
      focusRef.current = null;
    };
  }, [
    session.id,
    session.status,
    session.pipeline?.headless,
    onConnection,
    sendRef,
    focusRef,
    request,
  ]);
  useEffect(() => {
    if (mode === "terminal") terminalRef.current?.focus();
  }, [mode]);

  return { error, container, paste: (text) => terminalRef.current?.paste(text) };
}
