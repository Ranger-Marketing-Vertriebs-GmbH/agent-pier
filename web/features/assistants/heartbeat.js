// Mirrors server/features/assistants/heartbeat-schedule.js for the settings form.
export const heartbeatIntervals = { "1h": 1, "2h": 2, "4h": 4, daily: 24 };

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The stored heartbeat, or the off default in the owner's current time zone. */
export function heartbeatForm(assistant) {
  return {
    enabled: false,
    interval: "4h",
    start: 9,
    end: 18,
    timeZone: browserTimeZone(),
    telegram: true,
    ...assistant?.heartbeat,
  };
}

/** Check-ins per day: one per interval step within the active hours. */
export function heartbeatRuns({ interval, start, end }) {
  const step = heartbeatIntervals[interval] || 24;
  return end > start ? Math.ceil((end - start) / step) : 0;
}
