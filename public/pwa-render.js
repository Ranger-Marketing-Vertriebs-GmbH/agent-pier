/* global self */
// Words a push payload in the owner's language. The server sends data only (kind,
// link, names, preview, tag, count); every text comes from public/pwa-de.js or
// public/pwa-en.js. Pure functions, so tests run them without a service worker.
(() => {
  const id = "[A-Za-z0-9_-]{1,120}";
  const linkPattern = new RegExp(
    `^/(?:|inbox(?:/(?:question|approval|gate|action|team)/${id})?|sessions/${id}/chat|pipelines/runs/${id}|agents(?:/${id}/(?:settings|chats/${id}))?|settings/(?:github|notifications))$`,
  );
  const tagPattern = new RegExp(`^(?:(?:session|agent|run):)?${id}$`);
  const validId = (value) =>
    typeof value === "string" && new RegExp(`^${id}$`).test(value);
  const text = (value, limit) =>
    typeof value === "string" && value.trim()
      ? [...value.trim()].slice(0, limit).join("")
      : "";

  /** The page a notification opens; an older payload without a link still works. */
  function target(data) {
    if (typeof data?.link === "string" && linkPattern.test(data.link)) return data.link;
    if (data?.kind === "github-token") return "/settings/github";
    if (data?.kind === "disk-space") return "/";
    if (validId(data?.runId)) return `/pipelines/runs/${data.runId}`;
    if (validId(data?.assistantId) && validId(data?.conversationId))
      return `/agents/${data.assistantId}/chats/${data.conversationId}`;
    // A check-in without its chat opens the agents, never the agent's settings.
    if (validId(data?.assistantId)) return "/agents";
    if (validId(data?.sessionId)) return `/sessions/${data.sessionId}/chat`;
    return "/settings/notifications";
  }

  /** Title and body for a payload, at the detail level the server applied. */
  function render(payload, catalog) {
    const copy = catalog.kinds[payload.kind];
    const label = text(payload.label, 80);
    const subject = catalog.subjects[payload.subject] || "";
    const preview = text(payload.preview, 160);
    const context = [
      catalog.tools[payload.tool] || "",
      text(payload.stage, 80),
      text(payload.project, 80),
    ]
      .filter(Boolean)
      .join(" · ");
    // At the "event type only" level the server sends none of these.
    if (!label && !subject && !preview && !context)
      return { title: copy.title, body: copy.body };
    return {
      title:
        label || subject
          ? `${label || "AgentPier"} · ${subject || copy.name}`
          : copy.title,
      body: [preview ? catalog.quote(preview) : copy.body, context]
        .filter(Boolean)
        .join("\n"),
    };
  }

  /** The notification options: a grouped tag replaces, a blocking one alerts again. */
  function options(payload) {
    const tag =
      typeof payload.tag === "string" && tagPattern.test(payload.tag)
        ? payload.tag
        : validId(payload.eventId)
          ? payload.eventId
          : undefined;
    const grouped = Boolean(tag && tag !== payload.eventId);
    return {
      icon: "/pwa-icon-192.png",
      badge: "/pwa-icon-192.png",
      ...(tag ? { tag } : {}),
      ...(tag && payload.renotify === true ? { renotify: true } : {}),
      data: {
        link: target(payload),
        ...(grouped ? { group: tag } : {}),
      },
    };
  }

  /** The inbox count for the app badge, or null when the payload has none. */
  function badgeCount(payload) {
    return Number.isSafeInteger(payload.count) && payload.count >= 0
      ? payload.count
      : null;
  }

  self.agentPierNotificationRender = { render, options, target, badgeCount };
})();
