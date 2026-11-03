/** English messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
  source: Object.freeze({
    unauthorized: "The ticket source rejected the credentials. Please check the token.",
    forbidden: "The ticket source token has no permission for this.",
    notFound: "The ticket source did not find the request.",
    rateLimited:
      "The ticket source is limiting requests right now. Please try again later.",
    unavailable: "The ticket source is currently unavailable.",
    unreachable: "The ticket source cannot be reached.",
    invalidResponse: "The ticket source returned an unexpected response.",
    notConnected: "The ticket source is not connected for this project.",
  }),
});
