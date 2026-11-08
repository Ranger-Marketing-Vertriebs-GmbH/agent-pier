"""AgentPier's pdf tool for this agent: PDFs read like OpenClaw's pdf tool reads them.

Written by AgentPier into this agent's Hermes home as plugins/agentpier-team/pdf_tool.py
(hermes-config/pdf.js); the team plugin registers it while the agent may read PDFs.
Every call asks AgentPier first (the team plugin's guard, hermes-tool-guard.js): the
files must be the agent's own, and AgentPier names the model that reads them:

- "own": the agent's own model takes images. The page text and the images of pages
  without a text layer go back to it as a multimodal tool result.
- "fallback": the owner's PDF fallback model reads them (`fallback` in tools.json, its
  key in .env), and its answer goes back to the agent. No other model or provider
  ever gets the pages.
- "text": no model that reads images is available. The agent gets the text layer
  only; pages without one stay unread, as on OpenClaw with a text-only model.

Pages are read with PDFium (pypdfium2, which AgentPier installs into this Hermes
installation): the text of each page, and an image of each page with less than
`imageText` characters of text, within a pixel budget all such pages of a call share.
PDFium is not thread-safe and a hostile PDF may crash or stall it, so each PDF is read
in a child process of its own (this file run as a script) under a deadline; Hermes
runs subagents and chats in threads of one process. The tool opens the file itself,
once, and hands the child its bytes.
"""

import base64
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

_KEY = "AUXILIARY_AGENTPIER_PDF_API_KEY"
_UNAVAILABLE = "Reading PDFs is not available right now. Say so plainly; do not retry."
_MISSING = (
    "PDF reading is being installed for this agent. Read the PDF's text with read_file "
    "for now."
)
_SLOW = "Reading this PDF took too long. Try fewer pages with pages."
_DEFAULT_PROMPT = "Analyze this PDF document."
_INSTRUCTIONS = (
    "You read PDF documents for another assistant. Answer its request from the "
    "document's text and page images. Quote figures and names exactly."
)
_LOCAL = ("127.0.0.1", "localhost", "::1")
# The environment a reading child keeps: never the agent's keys.
_CHILD_ENV = ("PATH", "PYTHONPATH", "LANG", "LC_ALL", "TMPDIR", "HOME")


class Refused(Exception):
    pass


def _error(message):
    return json.dumps({"error": message})


def _key():
    try:
        from agent.secret_scope import get_secret_str

        value = get_secret_str(_KEY, "")
    except Exception:
        value = ""
    return value or os.environ.get(_KEY, "")


def _references(args):
    found = []
    if args.get("pdf") is not None:
        found.append(args["pdf"])
    pdfs = args.get("pdfs")
    if isinstance(pdfs, list):
        found.extend(pdfs)
    unique = []
    for value in found:
        if isinstance(value, str) and value.strip() and value not in unique:
            unique.append(value)
    return unique


def _resolve(value, folder):
    # The guard judged the same path: relative to the agent's own folder.
    target = os.path.realpath(os.path.join(folder, value))
    own = os.path.realpath(folder)
    if os.path.commonpath([own, target]) != own:
        raise Refused("Give PDFs as paths to files in your workspace, without a web address.")
    return target


def read_file(path, limit):
    """The bytes of the regular file `path` (resolved already), opened once and never
    through a link, refused above `limit` bytes or without a PDF header."""
    try:
        handle = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise Refused("No such file: " + os.path.basename(path))
    try:
        stat = os.fstat(handle)
        if not (stat.st_mode & 0o170000) == 0o100000:
            raise Refused("No such file: " + os.path.basename(path))
        if stat.st_size > limit:
            raise Refused("This PDF is larger than " + str(limit // (1024 * 1024)) + " MB.")
        chunks, size = [], 0
        while size <= limit:
            chunk = os.read(handle, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    finally:
        os.close(handle)
    data = b"".join(chunks)
    if len(data) > limit:
        raise Refused("This PDF is larger than " + str(limit // (1024 * 1024)) + " MB.")
    if b"%PDF-" not in data[:1024]:
        raise Refused(os.path.basename(path) + " is not a PDF.")
    return data


def parse_pages(spec, count, limit):
    """1-based page numbers from "1-5,7" (all pages without one), and whether `limit`
    cut the selection short."""
    if spec is None or (isinstance(spec, str) and not spec.strip()):
        wanted = list(range(1, count + 1))
    else:
        if not isinstance(spec, str) or not re.fullmatch(r"[0-9,\- ]+", spec):
            raise Refused('pages takes page numbers like "1-5" or "1,3,7-9".')
        wanted = set()
        for part in spec.replace(" ", "").split(","):
            if not part:
                continue
            first, _, last = part.partition("-")
            if not first or (_ and not last):
                raise Refused('pages takes page numbers like "1-5" or "1,3,7-9".')
            start, end = int(first), int(last or first)
            if start < 1 or end < start:
                raise Refused('pages takes page numbers like "1-5" or "1,3,7-9".')
            wanted.update(range(start, min(end, count) + 1))
        wanted = sorted(wanted)
        if not wanted:
            raise Refused("This PDF has " + str(count) + " pages.")
    return wanted[:limit], len(wanted) > limit


def _jpeg(image):
    out = io.BytesIO()
    image.convert("RGB").save(out, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def extract(data, settings, pages=None, password=None, budget=None):
    """`{ "count", "pages": [{ "page", "text", "image" }], "partial", "used" }`: an image
    only for a page with too little text, within `budget` pixels (`used` of them).
    Runs in the reading child (_child): PDFium is used by one thread only."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise Refused(_MISSING)
    try:
        document = pdfium.PdfDocument(data, password=password or None)
    except Exception:
        raise Refused(
            "This PDF cannot be opened"
            + (" with this password." if password else "; if it is encrypted, give its password.")
        )
    try:
        numbers, partial = parse_pages(pages, len(document), settings["maxPages"])
        read = []
        for number in numbers:
            page = document[number - 1]
            text = page.get_textpage().get_text_bounded() or ""
            read.append({"page": number, "text": text.strip(), "image": None, "_page": page})
        scans = [entry for entry in read if len(entry["text"]) < settings["imageText"]]
        left = settings["pixelBudget"] if budget is None else budget
        used = 0
        for index, entry in enumerate(scans):
            share = left / (len(scans) - index)
            width, height = entry["_page"].get_size()
            scale = min(math.sqrt(max(share, 0) / max(width * height, 1)), settings["maxScale"])
            if scale * min(width, height) < 1:
                continue
            try:
                image = entry["_page"].render(scale=scale).to_pil()
            except Exception:
                # OpenClaw drops a page image that fails and keeps the text.
                continue
            left -= image.width * image.height
            used += image.width * image.height
            entry["image"] = _jpeg(image)
        for entry in read:
            del entry["_page"]
        return {"count": len(document), "pages": read, "partial": partial, "used": used}
    finally:
        document.close()


_CHILD_MEMORY = 2 * 1024 * 1024 * 1024


def _child():
    # One PDF in this process alone: a JSON line, then the PDF's bytes, on stdin.
    # A decompression bomb hits this address-space cap (enforced on Linux; macOS
    # ignores RLIMIT_AS) instead of the host's memory; the timeout covers the rest.
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (_CHILD_MEMORY, _CHILD_MEMORY))
    except Exception:
        pass
    raw = sys.stdin.buffer.read()
    head, _, data = raw.partition(b"\n")
    try:
        job = json.loads(head.decode("utf-8"))
        result = {"document": extract(data, job["settings"], job.get("pages"), job.get("password"), job["budget"])}
    except Refused as refusal:
        result = {"error": str(refusal)}
    except Exception:
        result = {"error": _UNAVAILABLE}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def read_pdf(data, settings, pages, password, budget, deadline):
    """extract() in a child process that must finish before `deadline` (monotonic)."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise Refused(_SLOW)
    job = {"settings": settings, "pages": pages, "password": password, "budget": budget}
    env = {name: os.environ[name] for name in _CHILD_ENV if name in os.environ}
    try:
        done = subprocess.run(
            # -P: the plugin folder never shadows a module the child imports.
            [sys.executable, "-P", os.path.abspath(__file__)],
            input=json.dumps(job).encode("utf-8") + b"\n" + data,
            capture_output=True,
            timeout=left,
            env=env,
            cwd="/",
        )
    except subprocess.TimeoutExpired:
        raise Refused(_SLOW)
    try:
        result = json.loads(done.stdout.decode("utf-8"))
    except Exception:
        # A crash (a hostile PDF) ends the child, not the agent.
        raise Refused(_UNAVAILABLE)
    if "error" in result:
        raise Refused(result["error"])
    return result["document"]


def _document_text(name, document):
    numbers = [entry["page"] for entry in document["pages"]]
    lines = ["PDF " + name + ": " + str(document["count"]) + " pages"]
    if document["partial"]:
        lines.append(
            "Partial document: only pages "
            + ", ".join(str(n) for n in numbers)
            + " were read; ask for others with pages."
        )
    for entry in document["pages"]:
        lines.append("--- Page " + str(entry["page"]) + " ---")
        if entry["text"]:
            lines.append(entry["text"])
        if entry["image"]:
            lines.append("[This page has little or no text; its image follows.]")
        elif len(entry["text"]) < 1:
            lines.append("[No text on this page.]")
    return "\n".join(lines)


def _unread(documents):
    # Pages whose image a text-only reader cannot see.
    return [
        name + " page " + str(entry["page"])
        for name, document in documents
        for entry in document["pages"]
        if entry["image"]
    ]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect would carry the key to wherever it points: none is followed.
    def redirect_request(self, *args, **kwargs):
        return None


def _opener(url):
    host = urllib.parse.urlsplit(url).hostname or ""
    # AgentPier's model proxy on loopback: the host's proxy settings never apply.
    if host in _LOCAL:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    return urllib.request.build_opener(_NoRedirect)


def _lines(response, deadline):
    # The answer line by line, refused once `deadline` passes, however it trickles.
    for line in response:
        if time.monotonic() > deadline:
            raise Refused(_UNAVAILABLE)
        yield line


def _send(fallback, path, body, deadline):
    timeout = max(1.0, deadline - time.monotonic())
    headers = {"content-type": "application/json"}
    key = _key()
    if key:
        if fallback.get("keyHeader"):
            headers[fallback["keyHeader"]] = key
        else:
            headers["authorization"] = "Bearer " + key
    url = fallback["url"].rstrip("/") + path
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers
    )
    try:
        return _opener(url).open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        raise Refused(
            "The PDF model refused the request (HTTP " + str(error.code) + "). "
            + _UNAVAILABLE
        )
    except Exception:
        raise Refused(_UNAVAILABLE)


def _chat(fallback, prompt, images, deadline):
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": image}} for image in images
    ]
    body = {"model": fallback["model"], "messages": [{"role": "user", "content": content}]}
    with _send(fallback, "/chat/completions", body, deadline) as response:
        answer = json.loads(b"".join(_lines(response, deadline)).decode("utf-8"))
    text = answer["choices"][0]["message"]["content"]
    if isinstance(text, list):
        text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
    return str(text or "")


def _codex(fallback, prompt, images, deadline):
    # The Codex backend of a ChatGPT login, through AgentPier's model proxy: the
    # Responses API, streamed, never stored.
    content = [{"type": "input_text", "text": prompt}] + [
        {"type": "input_image", "image_url": image} for image in images
    ]
    body = {
        "model": fallback["model"],
        "instructions": _INSTRUCTIONS,
        "input": [{"type": "message", "role": "user", "content": content}],
        "stream": True,
        "store": False,
    }
    parts, done = [], ""
    with _send(fallback, "/responses", body, deadline) as response:
        for raw in _lines(response, deadline):
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except Exception:
                continue
            kind = event.get("type")
            if kind == "response.output_text.delta":
                parts.append(str(event.get("delta") or ""))
            elif kind == "response.output_item.done" and not parts:
                item = event.get("item") or {}
                done += "".join(
                    str(part.get("text") or "")
                    for part in item.get("content") or []
                    if isinstance(part, dict)
                )
            elif kind in ("response.failed", "error"):
                raise Refused(_UNAVAILABLE)
    return "".join(parts) or done


def _ask_fallback(fallback, prompt, text, images, deadline):
    request = prompt + "\n\n" + text
    images = images if fallback.get("images") else []
    call = _codex if fallback.get("api") == "codex" else _chat
    answer = call(fallback, request, images, deadline).strip()
    if not answer:
        raise Refused(_UNAVAILABLE)
    return answer


def handler(settings, ask):
    """The tool's handler; `ask(args, session_id, task_id)` is the guard's answer."""

    def run(args, session_id=None, task_id=None, **_):
        try:
            args = args if isinstance(args, dict) else {}
            answer = ask(args, session_id, task_id)
            if not isinstance(answer, dict) or answer.get("allow") is not True:
                message = answer.get("message") if isinstance(answer, dict) else None
                return _error(message or _UNAVAILABLE)
            reader = answer.get("reader")
            fallback = settings.get("fallback")
            # The fallback this home was compiled with reads only while it is still
            # the owner's: after a switch, until the home is applied again, text only.
            if reader == "fallback" and (
                not fallback or fallback.get("id") != answer.get("fallback")
            ):
                reader = "text"
            prompt = args.get("prompt")
            prompt = prompt.strip() if isinstance(prompt, str) and prompt.strip() else _DEFAULT_PROMPT
            password = args.get("password") if isinstance(args.get("password"), str) else None
            started = time.monotonic()
            deadline = started + settings["timeoutS"]
            files = [
                (value, read_file(_resolve(value, settings["folder"]), settings["maxBytes"]))
                for value in _references(args)
            ]
            documents = []
            budget = settings["pixelBudget"]
            for index, (value, data) in enumerate(files):
                # The call's pixel budget, shared by its PDFs; what one leaves the next get.
                share = budget / (len(files) - index)
                document = read_pdf(data, settings, args.get("pages"), password, share, deadline)
                budget -= document.pop("used", 0)
                documents.append((value, document))
            if not documents:
                raise Refused("Give a PDF path as pdf, or several as pdfs.")
            text = "\n\n".join(_document_text(name, doc) for name, doc in documents)
            images = [
                entry["image"]
                for _, doc in documents
                for entry in doc["pages"]
                if entry["image"]
            ]
            unread = _unread(documents)
            if reader == "own":
                summary = text + (
                    "\n\n[Page images of " + ", ".join(unread) + " could not be shown here.]"
                    if unread
                    else ""
                )
                if not images:
                    return json.dumps({"prompt": prompt, "text": text})
                return {
                    "_multimodal": True,
                    "content": [{"type": "text", "text": "Request: " + prompt + "\n\n" + text}]
                    + [{"type": "image_url", "image_url": {"url": image}} for image in images],
                    "text_summary": summary,
                }
            if reader == "fallback":
                analysis = _ask_fallback(
                    fallback, prompt, text, images, time.monotonic() + settings["timeoutS"]
                )
                return json.dumps({"text": analysis, "model": fallback["label"]})
            if not any(entry["text"] for _, doc in documents for entry in doc["pages"]):
                raise Refused(
                    "This PDF has no text layer, and no model that reads page images is "
                    "available to this agent."
                )
            result = {"text": text}
            if unread:
                result["note"] = (
                    "No model that reads page images is available to this agent, so these "
                    "pages without a text layer were not read: " + ", ".join(unread) + "."
                )
            return json.dumps(result)
        except Refused as refusal:
            return _error(str(refusal))
        except Exception:
            return _error(_UNAVAILABLE)

    return run


if __name__ == "__main__":
    _child()
