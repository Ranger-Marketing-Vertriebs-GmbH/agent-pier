// AgentPier's Deepgram speech-to-text for Hermes: a profile plugin that registers a
// transcription provider (agent/transcription_provider.py, `ctx.
// register_transcription_provider`, Hermes v0.22.5). With `stt.provider` naming it,
// Hermes's gateway hands every voice note of the agent's own Telegram bot to it
// (tools/transcription_tools.py: built-ins first, then command providers, then
// plugins; `stt.<provider>.model` and `.language` are passed in). It calls Deepgram's
// `/v1/listen` exactly as AgentPier does for its own channel layer
// (speech/deepgram-transcriber.js): the speech settings' model and language,
// `smart_format`, the agent's name as a key term, `Token <key>`, repeated after a
// rate limit. The key lives in the home's .env as an `AUXILIARY_*_API_KEY`, which
// Hermes strips from every command and process it starts
// (tools/environments/local_env_policy.py `_is_hermes_internal_secret`).

export const deepgramPlugin = "agentpier-deepgram";
export const deepgramDirectory = `plugins/${deepgramPlugin}`;
export const deepgramKeyEnv = "AUXILIARY_AGENTPIER_DEEPGRAM_API_KEY";
export const deepgramUrl = "https://api.deepgram.com/v1";

const manifest = `name: ${deepgramPlugin}
version: "1"
description: AgentPier transcribes voice notes with Deepgram
`;

const source = `"""AgentPier: voice notes of this agent's Telegram bot, transcribed by Deepgram.

Written by AgentPier into this agent's Hermes home; AgentPier replaces it on every
configuration change. The key comes from ${deepgramKeyEnv}.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from agent.transcription_provider import TranscriptionProvider

_NAME = "${deepgramPlugin}"
_KEY = "${deepgramKeyEnv}"
_TYPES = {".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
          ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
          ".wav": "audio/wav", ".webm": "audio/webm", ".flac": "audio/flac"}


def _key():
    try:
        from agent.secret_scope import get_secret_str
        value = get_secret_str(_KEY, "")
    except Exception:
        value = ""
    return value or os.environ.get(_KEY, "")


def _settings():
    try:
        from hermes_cli.config import load_config_readonly
        section = ((load_config_readonly() or {}).get("stt") or {}).get(_NAME) or {}
        return section if isinstance(section, dict) else {}
    except Exception:
        return {}


def _failed(error):
    return {"success": False, "transcript": "", "provider": _NAME, "error": error}


class DeepgramProvider(TranscriptionProvider):
    @property
    def name(self):
        return _NAME

    @property
    def display_name(self):
        return "Deepgram (AgentPier)"

    def is_available(self):
        return bool(_key())

    def default_model(self):
        return "nova-3"

    def transcribe(self, file_path, *, model=None, language=None, **extra):
        key = _key()
        if not key:
            return _failed("No Deepgram key")
        settings = _settings()
        model = model or settings.get("model") or "nova-3"
        language = language or settings.get("language") or "auto"
        query = [("model", model), ("smart_format", "true")]
        query.append(("detect_language", "true") if language == "auto" else ("language", language))
        for term in settings.get("keyterms") or []:
            if model.startswith("nova-3"):
                query.append(("keyterm", str(term)))
            elif model.startswith("nova-2"):
                query.append(("keywords", str(term).replace(":", " ") + ":2"))
        base = str(settings.get("base_url") or "${deepgramUrl}").rstrip("/")
        url = base + "/listen?" + urllib.parse.urlencode(query)
        kind = _TYPES.get(os.path.splitext(file_path)[1].lower(), "application/octet-stream")
        try:
            with open(file_path, "rb") as handle:
                audio = handle.read()
        except OSError:
            return _failed("The recording cannot be read")
        for attempt in range(4):
            request = urllib.request.Request(url, data=audio, method="POST", headers={
                "Authorization": "Token " + key, "Content-Type": kind})
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = json.loads(response.read() or b"{}")
                break
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                return _failed("Deepgram refused the recording (HTTP %d)" % error.code)
            except Exception:
                return _failed("Deepgram cannot be reached")
        try:
            transcript = body["results"]["channels"][0]["alternatives"][0]["transcript"]
        except (KeyError, IndexError, TypeError):
            transcript = ""
        transcript = str(transcript or "").strip()
        if not transcript:
            return _failed("Deepgram heard no speech")
        return {"success": True, "transcript": transcript, "provider": _NAME}


def register(ctx):
    ctx.register_transcription_provider(DeepgramProvider())
`;

/** The plugin's files, by path inside the Hermes home. */
export const deepgramFiles = Object.freeze({
  [`${deepgramDirectory}/plugin.yaml`]: manifest,
  [`${deepgramDirectory}/__init__.py`]: source,
});
