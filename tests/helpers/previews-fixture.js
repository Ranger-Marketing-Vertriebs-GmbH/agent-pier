// `GET /api/previews` as a fixture without previews: switched off on the default range.
// Agent chats (PreviewStrip.jsx) and session views (SessionPreviews.jsx) read it.
export const noPreviews = {
  settings: { enabled: false, portRangeStart: 47100, portRangeEnd: 47109 },
  previews: [],
  slots: [],
  serve: null,
};
