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

A second one, `agentpier.note { session_id, text }`, writes a routine's result into a
session's history the way Hermes records a result no one watched
(gateway/session_completion_notes.py) and mirrors a cron delivery
(cron/scheduler_delivery.py): one user row of the display kind
`internal_notification`, which every later turn of the session reads and no client
shows as the owner's words, appended through Hermes's own SessionDB to the session's
current compression segment. It answers `{ appended: true }`, or `{ appended: false,
reason: "not_found" }` for a session that is gone.

At its start the bridge makes sure the home has a session: Hermes appends a one-time
"very first message ever, introduce yourself" note to the first message a person sends
on a messaging platform while the home has no other session
(gateway/run_turn_prepare.py `_hmwa_first_contact_notes`, agent/onboarding.py
PLAIN_INTRO_NOTE), and no config key turns that plain note off. An agent whose first
message comes from a person writing to its own Telegram bot would otherwise greet that
stranger with it. The seed is one archived, ended session without messages
(`agentpier-first-contact`), which Hermes counts (SessionDB.session_count_ge counts
archived sessions) and never lists or sweeps (the empty-session sweep skips archived
ones).

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
# A routine result as a note: at most this many characters.
_NOTE_MAX_CHARS = 65536
_LOCAL_METHODS = {"agentpier.http", "agentpier.note"}


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


def note_call(params):
    """Appends one note row to a session's history; raises ValueError for a bad request."""
    session_id, text = params.get("session_id"), params.get("text")
    if (not isinstance(session_id, str) or not session_id or len(session_id) > 200
            or not isinstance(text, str) or not text.strip() or len(text) > _NOTE_MAX_CHARS):
        raise ValueError("invalid note")
    from hermes_state_registry import acquire, release_or_close

    db = acquire()
    try:
        if db.get_session(session_id) is None:
            return {"appended": False, "reason": "not_found"}
        # A compressed conversation goes on in its newest segment.
        target = db.get_compression_tip(session_id) or session_id
        db.append_message(session_id=target, role="user", content=text,
                          display_kind="internal_notification")
        return {"appended": True}
    finally:
        release_or_close(db)


# The session that tells Hermes this home has been talked to before.
_SEED_SESSION = "agentpier-first-contact"


def seed_first_contact():
    """Writes the seed session into a home without any session; True when it wrote it."""
    from hermes_state_registry import acquire, release_or_close

    db = acquire()
    try:
        if db.session_count_ge(1):
            return False
        db.create_session(_SEED_SESSION, "agentpier")
        db.end_session(_SEED_SESSION, "agentpier_seed")
        db.set_session_archived(_SEED_SESSION, True, notify=False)
        return True
    finally:
        release_or_close(db)


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
            if request.get("method") == "agentpier.note":
                result = await asyncio.to_thread(note_call, params)
            else:
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
        return request if isinstance(request, dict) and request.get("method") in _LOCAL_METHODS else None

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
    try:
        seed_first_contact()
    except Exception as error:  # Never keeps the channel from opening.
        sys.stderr.write(f"[agentpier-hermes-bridge] seed failed: {type(error).__name__}\n")
        sys.stderr.flush()
    url, protocols = ticket_target(home, endpoint)
    code = asyncio.run(relay(home, endpoint, url, protocols))
    if code:
        _fail(code, "gateway closed the channel")


if __name__ == "__main__":
    main()
