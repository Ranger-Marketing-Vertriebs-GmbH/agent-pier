// "Quiet while visible": open AgentPier pages report which view they show while the
// page is visible. A push is held back when, on any device, the inbox (for an inbox
// item) or the event's own session, agent chat or run was visible in the last 30
// seconds. Kept in memory only; nothing about it is stored on disk.

export const presenceWindowMs = 30000;
const maxViews = 200;
const reportsPerMinute = 120;
const id = "[A-Za-z0-9_-]{1,120}";

/** The view a route shows, as a presence key, or null for any other page. */
export function routeView(route) {
  if (typeof route !== "string" || route.length > 512) return null;
  const pathname = route.split(/[?#]/)[0];
  if (/^\/inbox(?:\/.*)?$/.test(pathname)) return "inbox";
  let match = new RegExp(`^/sessions/(${id})(?:/.*)?$`).exec(pathname);
  if (match) return `session:${match[1]}`;
  match = new RegExp(`^/agents/(${id})/(?:chats|teams)/${id}$`).exec(pathname);
  if (match) return `agent:${match[1]}`;
  match = new RegExp(`^/pipelines/runs/(${id})(?:/.*)?$`).exec(pathname);
  if (match) return `run:${match[1]}`;
  return null;
}

export class PushPresence {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.views = new Map();
    this.reports = [];
  }
  /** One report from a visible page; false when reports come in too fast. */
  report(route) {
    const now = this.now();
    this.reports = this.reports.filter((at) => now - at < 60000);
    if (this.reports.length >= reportsPerMinute) return false;
    this.reports.push(now);
    const view = routeView(route);
    if (!view) return true;
    this.views.delete(view);
    this.views.set(view, now);
    for (const [key, at] of this.views)
      if (this.views.size > maxViews || now - at >= presenceWindowMs)
        this.views.delete(key);
    return true;
  }
  seen(view, now = this.now()) {
    const at = this.views.get(view);
    return at !== undefined && now - at < presenceWindowMs;
  }
  /** Whether the owner is looking at what this event is about. */
  watching(event, source, now = this.now()) {
    return Boolean(
      (event.inbox && this.seen("inbox", now)) || (source && this.seen(source, now)),
    );
  }
}
