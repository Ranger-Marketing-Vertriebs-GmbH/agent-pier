/**
 * The browser session cookie. Over HTTPS it carries the `__Host-` prefix: the browser
 * then accepts it only with Secure, Path=/ and no Domain, so the host holds one such
 * cookie and a page cannot place a second beside it. Plain HTTP (loopback, network
 * mode) cannot use the prefix and keeps the earlier name, which HTTPS requests still
 * read until the session has moved.
 */
export const sessionCookie = "agentpier_session";
export const hostSessionCookie = "__Host-agentpier_session";
export const sessionCookieNames = Object.freeze([hostSessionCookie, sessionCookie]);

/** The name of a `name=value` cookie pair or of a Set-Cookie line. */
const nameOf = (pair) => pair.split("=")[0].trim();

/** Whether a cookie pair or a Set-Cookie line names AgentPier's session. */
export const namesSession = (pair) => sessionCookieNames.includes(nameOf(pair));

/** Every value a Cookie header carries under `name`, in header order. */
export function cookieValues(header, name = sessionCookie) {
  return (typeof header === "string" ? header : "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="))
    .map((part) => part.slice(name.length + 1));
}
