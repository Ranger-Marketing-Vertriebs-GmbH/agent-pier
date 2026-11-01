"""AgentPier's stdio channel to one Hermes agent's messaging gateway.

Hermes lets exactly one process own a HERMES_HOME (its gateway.lock): the stdio server
`python -m tui_gateway.entry` refuses a home a running gateway owns ("attach to it
instead"). The supervised `hermes gateway run` owns the home, so this process attaches
to it the way Hermes's own TUI does (ui-tui/scripts/gateway_bootstrap.py), except that
it only ever discovers the owner and never asks Hermes to start one: it mints a session
ticket over the owner-only control socket and relays the gateway's TUI JSON-RPC
WebSocket (/api/ws, the same newline-delimited protocol as stdio) to stdin and stdout.
The ticket never leaves this process.

One method never reaches the WebSocket: `agentpier.http { method, path, query, body }`
makes one call of the gateway's own REST API (the dashboard routes it hosts, such as
/api/cron/jobs) with a one-request `native-http` ticket from the same control socket
(hermes_cli/dashboard_auth/native_http.py), and answers `{ status, body }` under the
request's id (`{ timedOut: true }` for a call still running after its `timeout`
seconds). The ticket never leaves this process either.

Run with the Hermes environment's own Python: python -I hermes-rpc-bridge.py [seconds].
Exit codes: 0 when stdin closed, 2 when no ready owner appeared in time, 3 when the
gateway refused the ticket, 4 when the gateway closed the channel.
"""
import asyncio
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# The REST calls the bridge makes: only the gateway's own API, at most this long.
_HTTP_PREFIX = "/api/"
_HTTP_METHODS = {"GET", "POST", "PUT", "DELETE"}
_HTTP_TIMEOUT = 30
_HTTP_MAX_TIMEOUT = 120
_HTTP_MAX_BYTES = 16 * 1024 * 1024


def _fail(code, message):
    sys.stderr.write(f"[agentpier-hermes-bridge] {message}\n")
    sys.stderr.flush()
    raise SystemExit(code)


def owner(home, deadline):
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint

    while True:
        receipt = discover_gateway_endpoint(home, timeout=5)
        if attachable(receipt):
            return receipt.endpoint
        if time.monotonic() > deadline:
            _fail(2, f"gateway {receipt.state}: {receipt.reason_code or 'not ready'}")
        time.sleep(0.25)


def mint(home, endpoint, purpose):
    """A ticket of `purpose` from the owner's control socket, or None when refused."""
    from hermes_cli.gateway_runtime import control_home_for
    from hermes_cli.gateway_runtime_discovery import connect_private

    request = json.dumps({"protocol": 1, "id": 1, "verb": "session-ticket", "params": {
        "profile_id": endpoint.profile_id, "instance_id": endpoint.instance_id,
        "purpose": purpose}}).encode() + b"\n"
    with connect_private(control_home_for(home, endpoint), 5) as peer:
        peer.sendall(request)
        with peer.makefile("rb") as stream:
            raw = stream.readline(65537)
    try:
        result = json.loads(raw)
        grant = result.get("result", {})
        if (result.get("ok") is not True or grant.get("instance_id") != endpoint.instance_id
                or not isinstance(grant.get("ticket"), str)):
            raise ValueError
    except (ValueError, AttributeError):
        return None
    return grant["ticket"]


def ticket_target(home, endpoint):
    from hermes_cli.gateway_client import gateway_ws_target

    ticket = mint(home, endpoint, "interactive")
    if ticket is None:
        _fail(3, "gateway refused the session ticket")
    return gateway_ws_target(endpoint, ticket)


def rest_call(home, endpoint, params):
    """One REST call of the gateway's API as `{ status, body }`; raises ValueError for a
    request the bridge does not make."""
    from hermes_cli.gateway_runtime import discover_gateway_endpoint, attachable

    method = str(params.get("method", "GET")).upper()
    path = params.get("path")
    query = params.get("query") or {}
    timeout = params.get("timeout", _HTTP_TIMEOUT)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= _HTTP_MAX_TIMEOUT:
        raise ValueError("invalid timeout")
    if (method not in _HTTP_METHODS or not isinstance(path, str) or not path.startswith(_HTTP_PREFIX)
            or ".." in path or "?" in path or "#" in path or not isinstance(query, dict)):
        raise ValueError("invalid request")
    # The owner may have restarted its listener: always the current endpoint.
    receipt = discover_gateway_endpoint(home, timeout=5)
    current = receipt.endpoint if attachable(receipt) else endpoint
    ticket = mint(home, current, "native-http")
    if ticket is None:
        return {"status": 401, "body": None}
    url = current.api_origin + urllib.parse.quote(path) + (
        "?" + urllib.parse.urlencode({k: str(v) for k, v in query.items()}) if query else "")
    data = None
    headers = {"x-hermes-gateway-ticket": ticket, "accept": "application/json"}
    if "body" in params and params["body"] is not None:
        data = json.dumps(params["body"]).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    # Loopback only: never through the host's HTTP(S) proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            status, raw = response.status, response.read(_HTTP_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read(_HTTP_MAX_BYTES + 1)
    except TimeoutError:
        return {"status": 0, "body": None, "timedOut": True}
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            return {"status": 0, "body": None, "timedOut": True}
        raise
    if len(raw) > _HTTP_MAX_BYTES:
        raise ValueError("response too large")
    try:
        body = json.loads(raw) if raw else None
    except ValueError:
        body = None
    return {"status": status, "body": body}


async def relay(home, endpoint, url, protocols):
    from websockets.asyncio.client import connect
    from hermes_cli.gateway_client import GATEWAY_WS_PROTOCOL

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    calls = set()

    def answer(frame):
        sys.stdout.write(json.dumps(frame) + "\n")
        sys.stdout.flush()

    async def http(request):
        rid = request.get("id")
        try:
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            result = await asyncio.to_thread(rest_call, home, endpoint, params)
            answer({"jsonrpc": "2.0", "id": rid, "result": result})
        except Exception as error:  # A failed call answers; it never ends the channel.
            reason = "invalid_params" if isinstance(error, ValueError) else "http_failed"
            answer({"jsonrpc": "2.0", "id": rid, "error": {
                "code": 4001, "message": reason, "data": {"reason": reason}}})

    def local(line):
        try:
            request = json.loads(line)
        except ValueError:
            return None
        return request if isinstance(request, dict) and request.get("method") == "agentpier.http" else None

    # Loopback only: never through the host's HTTP(S) proxy.
    async with connect(url, subprotocols=protocols, proxy=None, open_timeout=10,
                       max_size=64 * 1024 * 1024) as ws:
        if ws.subprotocol != GATEWAY_WS_PROTOCOL:
            _fail(3, "gateway protocol mismatch")

        async def upstream():
            while line := await reader.readline():
                text = line.decode("utf-8").strip()
                if not text:
                    continue
                request = local(text)
                if request is None:
                    await ws.send(text)
                    continue
                task = asyncio.ensure_future(http(request))
                calls.add(task)
                task.add_done_callback(calls.discard)
            await ws.close()
            return 0

        async def downstream():
            async for message in ws:
                text = message.decode("utf-8") if isinstance(message, bytes) else message
                for part in text.splitlines():
                    if part.strip():
                        sys.stdout.write(part + "\n")
                sys.stdout.flush()
            return 4

        tasks = [asyncio.ensure_future(upstream()), asyncio.ensure_future(downstream())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in [*pending, *calls]:
            task.cancel()
        return next(iter(done)).result()


def main():
    from hermes_constants import get_hermes_home

    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    home = get_hermes_home().resolve()
    endpoint = owner(home, time.monotonic() + seconds)
    url, protocols = ticket_target(home, endpoint)
    code = asyncio.run(relay(home, endpoint, url, protocols))
    if code:
        _fail(code, "gateway closed the channel")


if __name__ == "__main__":
    main()
