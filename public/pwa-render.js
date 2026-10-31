/* global self */
// Words a push payload in the owner's language. The server sends data only (kind,
// link, names, preview, tag, count); every text comes from public/pwa-de.js or
// public/pwa-en.js. Pure functions, so tests run them without a service worker.
(() => {
  const id = "[A-Za-z0-9_-]{1,120}";
  const linkPattern = new RegExp(
    `^/(?:|inbox(?:/(?:question|approval|gate|action|team)/${id})?|sessions/${id}/chat|pipelines/runs/${id}|agents(?:/${id}/(?:settings|chats/${id}))?|connections\\?section=github|settings/(?:github|notifications|updates))$`,
  );
  // The grouping tags of push-content.js pushSource: a session, run, agent chat or agent.
  const tagPattern = new RegExp(`^(?:(?:session|agent|chat|run):)?${id}$`);
  const validId = (value) =>
    typeof value === "string" && new RegExp(`^${id}$`).test(value);
  const text = (value, limit) =>
    typeof value === "string" && value.trim()
      ? [...value.trim()].slice(0, limit).join("")
      : "";

  /** The page a notification opens; an older payload without a link still works. */
  function target(data) {
    if (typeof data?.link === "string" && linkPattern.test(data.link)) return data.link;
    if (data?.kind === "github-token") return "/connections?section=github";
    if (data?.kind === "disk-space") return "/";
    if (data?.kind === "update-available" || data?.kind === "update-failed")
      return "/settings/updates";
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
    // A CLI approval names the tool that asks, never what it would run.
    const toolName =
      payload.kind === "permission" &&
      typeof payload.toolName === "string" &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(payload.toolName)
        ? payload.toolName
        : "";
    const context = [
      catalog.tools[payload.tool] || "",
      text(payload.stage, 80),
      text(payload.project, 80),
    ]
      .filter(Boolean)
      .join(" · ");
    // At the "event type only" level the server sends none of these.
    if (!label && !subject && !preview && !context && !toolName)
      return { title: copy.title, body: copy.body };
    return {
      title:
        label || subject
          ? `${label || "AgentPier"} · ${subject || copy.name}`
          : copy.title,
      body: [
        preview
          ? catalog.quote(preview)
          : toolName
            ? catalog.toolRequest(toolName)
            : copy.body,
        context,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const decidable = /^\/inbox\/(approval|action)\/([A-Za-z0-9_-]{1,120})$/;
  const inboxItem = new RegExp(`^/inbox/(?:question|approval|gate|action|team)/${id}$`);

  /**
   * The inbox address of the item a payload waits as: its `item`, or the `link` of an
   * older payload that still opened the inbox.
   */
  function item(payload) {
    for (const value of [payload?.item, payload?.link])
      if (typeof value === "string" && inboxItem.test(value)) return value;
    return "";
  }

  /**
   * Allow and Deny for an approval the server marked decidable, naming its inbox item
   * and revision; the platform shows them where it supports actions (not iOS).
   */
  function decision(payload) {
    const decided = decidable.exec(item(payload));
    if (
      !decided ||
      !["both", "deny"].includes(payload.decide) ||
      !Number.isSafeInteger(payload.revision)
    )
      return null;
    return {
      type: decided[1],
      id: decided[2],
      revision: payload.revision,
      allow: payload.decide === "both",
    };
  }

  /** The notification options: a grouped tag replaces, a blocking one alerts again. */
  function options(payload, catalog) {
    const decide = catalog ? decision(payload) : null;
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
      ...(decide
        ? {
            actions: [
              ...(decide.allow
                ? [{ action: "allow", title: catalog.actions.allow }]
                : []),
              { action: "deny", title: catalog.actions.deny },
            ],
          }
        : {}),
      data: {
        link: target(payload),
        // Where a failed Allow or Deny leads: the inbox item explains why.
        ...(decide ? { item: item(payload) } : {}),
        ...(grouped ? { group: tag } : {}),
        ...(decide ? { decision: decide } : {}),
      },
    };
  }

  /** The inbox count for the app badge, or null when the payload has none. */
  function badgeCount(payload) {
    return Number.isSafeInteger(payload.count) && payload.count >= 0
      ? payload.count
      : null;
  }

  self.agentPierNotificationRender = { render, options, target, item, badgeCount };
})();
