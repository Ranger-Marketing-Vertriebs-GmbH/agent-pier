"""AgentPier's stdio channel to one Hermes agent's messaging gateway.

Hermes lets exactly one process own a HERMES_HOME (its gateway.lock): the stdio server
`python -m tui_gateway.entry` refuses a home a running gateway owns ("attach to it
instead"). The supervised `hermes gateway run` owns the home, so this process attaches
to it the way Hermes's own TUI does (ui-tui/scripts/gateway_bootstrap.py), except that
it only ever discovers the owner and never asks Hermes to start one: it mints a session
ticket over the owner-only control socket and relays the gateway's TUI JSON-RPC
WebSocket (/api/ws, the same newline-delimited protocol as stdio) to stdin and stdout.
The ticket never leaves this process.

Run with the Hermes environment's own Python: python -I hermes-rpc-bridge.py [seconds].
Exit codes: 0 when stdin closed, 2 when no ready owner appeared in time, 3 when the
gateway refused the ticket, 4 when the gateway closed the channel.
"""
import asyncio
import json
import sys
import time


def _fail(code, message):
    sys.stderr.write(f"[agentpier-hermes-bridge] {message}\n")
    sys.stderr.flush()
    raise SystemExit(code)


def ticket_target(home, deadline):
    from hermes_cli.gateway_client import gateway_ws_target
    from hermes_cli.gateway_runtime import attachable, control_home_for, discover_gateway_endpoint
    from hermes_cli.gateway_runtime_discovery import connect_private

    while True:
        receipt = discover_gateway_endpoint(home, timeout=5)
        if attachable(receipt):
            break
        if time.monotonic() > deadline:
            _fail(2, f"gateway {receipt.state}: {receipt.reason_code or 'not ready'}")
        time.sleep(0.25)
    endpoint = receipt.endpoint
    request = json.dumps({"protocol": 1, "id": 1, "verb": "session-ticket", "params": {
        "profile_id": endpoint.profile_id, "instance_id": endpoint.instance_id,
        "purpose": "interactive"}}).encode() + b"\n"
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
        _fail(3, "gateway refused the session ticket")
    return gateway_ws_target(endpoint, grant["ticket"])


async def relay(url, protocols):
    from websockets.asyncio.client import connect
    from hermes_cli.gateway_client import GATEWAY_WS_PROTOCOL

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    # Loopback only: never through the host's HTTP(S) proxy.
    async with connect(url, subprotocols=protocols, proxy=None, open_timeout=10,
                       max_size=64 * 1024 * 1024) as ws:
        if ws.subprotocol != GATEWAY_WS_PROTOCOL:
            _fail(3, "gateway protocol mismatch")

        async def upstream():
            while line := await reader.readline():
                if line.strip():
                    await ws.send(line.decode("utf-8").strip())
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
        for task in pending:
            task.cancel()
        return next(iter(done)).result()


def main():
    from hermes_constants import get_hermes_home

    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    url, protocols = ticket_target(get_hermes_home().resolve(), time.monotonic() + seconds)
    code = asyncio.run(relay(url, protocols))
    if code:
        _fail(code, "gateway closed the channel")


if __name__ == "__main__":
    main()
