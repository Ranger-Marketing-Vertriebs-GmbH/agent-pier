import React, { lazy, Suspense, useState } from "react";
import { AssistantEventsContext, AssistantsStateContext } from "./useAssistants.js";
const AssistantsHost = lazy(() => import("./AssistantsRoot.jsx"));
// Always mounted at the same place, so enabling or disabling agents never remounts
// the application: only the data host beside the children comes and goes.
export default function AssistantsGate({ enabled, children }) {
  const [state, setState] = useState(null);
  const [events, setEvents] = useState(null);
  return (
    <AssistantsStateContext.Provider value={state}>
      <AssistantEventsContext.Provider value={events}>
        {children}
        {enabled && (
          <Suspense fallback={null}>
            <AssistantsHost publishState={setState} publishEvents={setEvents} />
          </Suspense>
        )}
      </AssistantEventsContext.Provider>
    </AssistantsStateContext.Provider>
  );
}
