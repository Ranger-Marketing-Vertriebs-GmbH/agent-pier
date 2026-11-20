(() => {
  // The service worker shows this page when a navigation gets no answer. That happens
  // when the device has no network, and also when the device is online but AgentPier
  // itself is stopped or restarting: the two get different help. The page then asks
  // AgentPier again by itself, with growing pauses, and reloads once it answers.
  const copy = {
    de: {
      deviceTitle: "Dieses Gerät ist offline",
      deviceText:
        "Verbinde dieses Gerät mit dem Netzwerk. AgentPier öffnet sich wieder, sobald die Verbindung zurück ist.",
      serverTitle: "AgentPier ist nicht erreichbar",
      serverText:
        "Dieses Gerät ist online, aber AgentPier antwortet nicht. Es startet vielleicht gerade neu oder wurde beendet. Diese Seite versucht es selbst erneut.",
      retry: "Jetzt erneut versuchen",
      checking: "Verbindung wird geprüft …",
      waiting: (seconds) => `Nächster Versuch in ${seconds} s.`,
      back: "AgentPier antwortet wieder. Die Seite wird neu geladen …",
    },
    en: {
      deviceTitle: "This device is offline",
      deviceText:
        "Connect this device to the network. AgentPier opens again as soon as the connection is back.",
      serverTitle: "AgentPier is not reachable",
      serverText:
        "This device is online, but AgentPier does not answer. It may be restarting or stopped. This page tries again by itself.",
      retry: "Try again now",
      checking: "Checking the connection …",
      waiting: (seconds) => `Next try in ${seconds} s.`,
      back: "AgentPier answers again. Reloading the page …",
    },
  };
  let saved;
  try {
    saved = localStorage.getItem("agentpier-language");
  } catch {
    // Offline help also works when browser storage is restricted.
  }
  const preferred = (navigator.languages || [navigator.language])
    .map((value) => String(value).toLowerCase().split("-")[0])
    .find((value) => value === "de" || value === "en");
  const language = saved === "de" || saved === "en" ? saved : preferred || "en";
  const text = copy[language];
  document.documentElement.lang = language;
  const title = document.querySelector("h1");
  const help = document.querySelector("p");
  const status = document.querySelector("#offline-status");
  const button = document.querySelector("a");
  button.textContent = text.retry;
  const describe = () => {
    const device = navigator.onLine === false;
    title.textContent = device ? text.deviceTitle : text.serverTitle;
    help.textContent = device ? text.deviceText : text.serverText;
  };
  describe();

  // 2 s, 4 s, 8 s … up to one minute between tries.
  const FIRST_DELAY = 2000;
  const LONGEST_DELAY = 60_000;
  let delay = FIRST_DELAY;
  let timer = null;
  let probing = false;
  let done = false;
  const schedule = () => {
    clearTimeout(timer);
    status.textContent = text.waiting(Math.round(delay / 1000));
    timer = setTimeout(probe, delay);
    delay = Math.min(delay * 2, LONGEST_DELAY);
  };
  // Any HTTP answer, a refused sign-in too, means AgentPier is back. /api is never
  // answered by the service worker, so this always reaches the server.
  async function probe() {
    if (probing || done) return;
    probing = true;
    clearTimeout(timer);
    status.textContent = text.checking;
    try {
      await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
      done = true;
      status.textContent = text.back;
      location.reload();
    } catch {
      describe();
      schedule();
    } finally {
      probing = false;
    }
  }
  const tryNow = () => {
    delay = FIRST_DELAY;
    describe();
    probe();
  };
  addEventListener("online", tryNow);
  addEventListener("offline", describe);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryNow();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    tryNow();
  });
  schedule();
})();
