import fs from "node:fs";
import path from "node:path";

// An agent's web search and web fetch on Hermes (website/docs/user-guide/features/
// web-search.md, tools/web_tools.py at v0.22.5): `web_search` and `web_extract` (the
// `web` toolset; `search` holds web_search alone) run on the backends
// `web.search_backend` and `web.extract_backend` pin, each a bundled or a plugin
// provider (agent/web_search_registry.py). The owner's choice for every agent
// (web-search-settings.js) maps to:
// - DuckDuckGo: Hermes's `ddgs` backend, when the installation has the ddgs package
//   (pyproject extra `ddgs`); otherwise web search is named unsupported.
// - Brave: Hermes's `brave-free` backend (Brave's web search API, the same one
//   OpenClaw's Brave plugin calls) with BRAVE_SEARCH_API_KEY in .env, which Hermes
//   strips from every command and process it starts (tools/environments/
//   local_env_policy.py: OPTIONAL_ENV_VARS of category `tool`).
// - Perplexity through an OpenRouter connection: Hermes's own Perplexity backend
//   calls Perplexity's Search API (POST /search), which OpenRouter does not serve, so
//   AgentPier's web plugin asks `perplexity/sonar-pro` through OpenRouter's chat
//   completions, as OpenClaw's Perplexity plugin does
//   (docs/assistant-web-tools-qualification.md).
// Web fetch is AgentPier's plugin too: Hermes has no extract backend that fetches a
// page itself (every one is a third-party service), so `agentpier-fetch` reads the
// page directly, refusing private, loopback, link-local and metadata addresses at
// every connect and redirect, as OpenClaw's web_fetch does (ssrfPolicy) — whatever
// the owner's browser network setting says. An agent without web fetch keeps that
// backend pinned, which then refuses every page, since Hermes offers web_extract
// with web_search in one toolset. `web.keyless_fallback` stays off (home.js).

export const webPlugin = "agentpier-web";
export const webDirectory = `plugins/${webPlugin}`;
export const braveKeyEnv = "BRAVE_SEARCH_API_KEY";
export const perplexityKeyEnv = "AUXILIARY_AGENTPIER_WEB_SEARCH_API_KEY";
/** Every .env name this module owns while the web settings are known. */
export const webEnvNames = Object.freeze([braveKeyEnv, perplexityKeyEnv]);
const fetchBackend = "agentpier-fetch";
const perplexityBackend = "agentpier-perplexity";
const openRouterUrl = "https://openrouter.ai/api/v1";
const perplexityModel = "perplexity/sonar-pro";

const manifest = `name: ${webPlugin}
version: "1"
description: AgentPier web fetch and Perplexity search through OpenRouter
`;

const source = `"""AgentPier web tools for this agent: web fetch, and Perplexity through OpenRouter.

Written by AgentPier into this agent's Hermes home; AgentPier replaces it on every
configuration change. web.json says whether this agent may fetch pages.
"""

import html.parser
import json
import os
import socket
import urllib.error
import urllib.request

from agent.web_search_provider import WebSearchProvider

_DIR = os.path.dirname(os.path.abspath(__file__))
_KEY = "${perplexityKeyEnv}"
_URL = "${openRouterUrl}/chat/completions"
_MODEL = "${perplexityModel}"
# A page larger than this is cut; Hermes truncates the text again (extract_char_limit).
_MAX_BYTES = 5 * 1024 * 1024
_TIMEOUT = 30
_SKIPPED = {"script", "style", "noscript", "template", "svg", "head"}
_BLOCKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
           "section", "article", "header", "footer", "pre", "blockquote", "table"}
_OFF = "Fetching web pages is not enabled for this agent."


def _settings():
    try:
        with open(os.path.join(_DIR, "web.json"), encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _key():
    try:
        from agent.secret_scope import get_secret_str
        value = get_secret_str(_KEY, "")
    except Exception:
        value = ""
    return value or os.environ.get(_KEY, "")


class _Text(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.title, self._skip, self._in_title = [], "", 0, False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag in _SKIPPED:
            self._skip += 1
        elif tag in _BLOCKS:
            self.parts.append("\\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in _SKIPPED and self._skip:
            self._skip -= 1
        elif tag in _BLOCKS:
            self.parts.append("\\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)

    def text(self):
        lines = (" ".join(line.split()) for line in "".join(self.parts).splitlines())
        out, blank = [], False
        for line in lines:
            if line or not blank:
                out.append(line)
            blank = not line
        return "\\n".join(out).strip()


def _client():
    # Hermes's connect-time SSRF guard (tools/url_safety.py), with private networks
    # always refused: the browser's network setting never widens web fetch.
    import httpx
    from tools import url_safety as safety

    class _Strict(safety._SSRFGuardedNetworkBackend):
        def _connect_ips(self, host, port):
            name = safety._normalize_hostname(host)
            if not name or name in safety._BLOCKED_HOSTNAMES:
                raise safety.SSRFConnectionBlocked("Blocked request to an internal host")
            try:
                found = safety._getaddrinfo(name, port)
            except socket.gaierror as error:
                raise safety.SSRFConnectionBlocked("DNS resolution failed") from error
            ips = []
            for _raw, text, ip in safety._iter_resolved_ips(found):
                if ip is None or safety._resolved_ip_block_reason(ip, False):
                    raise safety.SSRFConnectionBlocked(
                        "Blocked request to a private or internal address")
                if text not in ips:
                    ips.append(text)
            if not ips:
                raise safety.SSRFConnectionBlocked("DNS returned no address")
            return ips

    # No proxy: only the direct transport carries the guard.
    client = httpx.Client(trust_env=False, follow_redirects=True, max_redirects=5,
                          timeout=_TIMEOUT, headers={"user-agent": "AgentPier web fetch"})
    safety._install_ssrf_guard_on_client(client)
    pool = client._transport._pool
    pool._network_backend = _Strict(pool._network_backend._schemes_by_origin_var)
    return client


def _page(client, url):
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        return {"url": str(url), "title": "", "content": "", "error": "Only http and https pages can be fetched."}
    with client.stream("GET", url) as response:
        body = b""
        for chunk in response.iter_bytes():
            body += chunk
            if len(body) >= _MAX_BYTES:
                break
        kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if response.status_code >= 400:
            return {"url": url, "title": "", "content": "", "error": f"HTTP {response.status_code}"}
        text = body.decode(response.encoding or "utf-8", errors="replace")
        title = ""
        if kind in ("text/html", "application/xhtml+xml") or (not kind and "<html" in text[:2000].lower()):
            parser = _Text()
            parser.feed(text)
            text, title = parser.text(), " ".join(parser.title.split())
        elif not (kind.startswith("text/") or kind.endswith(("json", "xml"))):
            return {"url": url, "title": "", "content": "", "error": f"Not a text page ({kind})."}
        final = str(response.url)
        return {"url": url, "title": title, "content": text, "raw_content": text,
                "metadata": {"sourceURL": final, "title": title}}


class _Fetch(WebSearchProvider):
    name = property(lambda self: "${fetchBackend}")
    display_name = property(lambda self: "AgentPier web fetch")

    def is_available(self):
        return True

    def supports_search(self):
        return False

    def supports_extract(self):
        return True

    def extract(self, urls, **kwargs):
        urls = list(urls or [])
        if _settings().get("fetch") is not True:
            return [{"url": u, "title": "", "content": "", "error": _OFF} for u in urls]
        out = []
        try:
            client = _client()
        except Exception:
            return [{"url": u, "title": "", "content": "", "error": "Web fetch is unavailable."} for u in urls]
        with client:
            for url in urls:
                try:
                    out.append(_page(client, url))
                except Exception as error:
                    out.append({"url": str(url), "title": "", "content": "",
                                "error": f"Fetch failed: {type(error).__name__}: {error}"[:500]})
        return out


class _Perplexity(WebSearchProvider):
    name = property(lambda self: "${perplexityBackend}")
    display_name = property(lambda self: "Perplexity through OpenRouter")

    def is_available(self):
        return bool(_key())

    def search(self, query, limit=5):
        key = _key()
        if not key:
            return {"success": False, "error": "No OpenRouter key for Perplexity search."}
        body = json.dumps({"model": _MODEL, "messages": [{"role": "user", "content": str(query)}]})
        request = urllib.request.Request(_URL, data=body.encode("utf-8"), method="POST", headers={
            "authorization": "Bearer " + key, "content-type": "application/json",
            "x-title": "AgentPier"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return {"success": False, "error": f"Perplexity search failed: HTTP {error.code}"}
        except Exception as error:
            return {"success": False, "error": f"Perplexity search failed: {type(error).__name__}"}
        message = ((data.get("choices") or [{}])[0].get("message") or {})
        answer = message.get("content") or ""
        cited = []
        for note in message.get("annotations") or []:
            hit = note.get("url_citation") if isinstance(note, dict) else None
            if isinstance(hit, dict) and isinstance(hit.get("url"), str):
                cited.append((hit["url"], hit.get("title") or hit["url"]))
        for url in data.get("citations") or []:
            if isinstance(url, str) and url not in [c[0] for c in cited]:
                cited.append((url, url))
        rows = [{"title": title, "url": url, "description": "", "position": i + 1}
                for i, (url, title) in enumerate(cited[:max(1, int(limit))])]
        if rows:
            rows[0]["description"] = answer[:4000]
        elif answer:
            rows = [{"title": "Perplexity answer", "url": "", "description": answer[:4000], "position": 1}]
        return {"success": True, "data": {"web": rows}}


def register(ctx):
    ctx.register_web_search_provider(_Fetch())
    ctx.register_web_search_provider(_Perplexity())
`;

/**
 * Whether the installation `record` (hermes-install.js) has the ddgs package Hermes's
 * DuckDuckGo backend imports (tools/web_tools.py _ddgs_package_importable). Reads the
 * installation's virtual environment.
 */
export function ddgsInstalled(record) {
  if (typeof record?.directory !== "string") return false;
  const lib = path.join(record.directory, "venv", "lib");
  try {
    return fs
      .readdirSync(lib)
      .filter((name) => name.startsWith("python"))
      .some((name) => fs.existsSync(path.join(lib, name, "site-packages", "ddgs")));
  } catch {
    return false;
  }
}

const safeKey = (key) => typeof key === "string" && !!key && !/['\r\n]/.test(key);

/**
 * The web search and fetch part of `agent`'s home (a desiredAgent): `{ plugin,
 * files, toolsets, config, env, unsupported }`, or null for an agent with neither.
 * `web`: `{ search, ddgs }` — the owner's resolved search settings
 * (WebSearchSettings.resolve: `{ provider, key?, unavailable? }`) and whether the
 * installation has ddgs (ddgsInstalled); without it the search backend stays as it
 * is (home.js then owns no key name either). `env.values`: the key to write. Pure.
 */
export function webHome(agent, web) {
  const { webSearch, webFetch } = agent.web;
  if (!webSearch && !webFetch) return null;
  const known = !!web && typeof web === "object";
  const search = known ? web.search || {} : {};
  let backend = null;
  const values = {};
  if (webSearch && known && !search.unavailable) {
    if (search.provider === "duckduckgo" && web.ddgs === true) backend = "ddgs";
    else if (search.provider === "brave" && safeKey(search.key)) {
      backend = "brave-free";
      values[braveKeyEnv] = search.key;
    } else if (search.provider === "perplexity" && safeKey(search.key)) {
      backend = perplexityBackend;
      values[perplexityKeyEnv] = search.key;
    }
  }
  const searching = !!backend;
  return Object.freeze({
    plugin: webPlugin,
    files: Object.freeze({
      [`${webDirectory}/plugin.yaml`]: manifest,
      [`${webDirectory}/__init__.py`]: source,
      [`${webDirectory}/web.json`]: `${JSON.stringify({ fetch: !!webFetch }, null, 2)}\n`,
    }),
    // web_search alone (`search`) goes while no backend can serve it; a search
    // whose settings are unknown keeps what the home has.
    toolsets: !webSearch || (known && !searching) ? ["search"] : [],
    config: Object.freeze([
      [["web", "extract_backend"], fetchBackend],
      ...(known ? [[["web", "search_backend"], backend ?? undefined]] : []),
    ]),
    env: Object.freeze({ values }),
    unsupported: Object.freeze(webSearch && known && !searching ? ["webSearch"] : []),
  });
}
