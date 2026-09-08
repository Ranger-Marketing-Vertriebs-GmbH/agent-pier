(() => {
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
  document.documentElement.lang = language;
  if (language !== "en") return;
  document.querySelector("h1").textContent = "AgentPier is offline";
  document.querySelector("p").textContent =
    "Connect this device to the network and open AgentPier again. Sessions and chats are not stored here for offline access.";
  document.querySelector("a").textContent = "Reconnect";
})();
