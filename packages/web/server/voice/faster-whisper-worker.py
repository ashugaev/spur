#!/usr/bin/env python3

import argparse
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--model", default="base")
parser.add_argument("--model-path")
parser.add_argument("--compute-type", default="int8")
parser.add_argument("--device", default="auto")
args = parser.parse_args()

try:
    from faster_whisper import WhisperModel
except Exception as exc:
    emit({"type": "fatal", "error": f"Failed to import faster-whisper: {exc}"})
    raise SystemExit(1)


model_ref = args.model_path or args.model

try:
    model = WhisperModel(model_ref, device=args.device, compute_type=args.compute_type)
except Exception as exc:
    emit({"type": "fatal", "error": f"Failed to load faster-whisper model '{model_ref}': {exc}"})
    raise SystemExit(1)

emit({"type": "ready"})

for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    try:
        message = json.loads(line)
    except Exception:
        continue

    request_id = message.get("id")
    if message.get("action") != "transcribe" or not isinstance(request_id, str):
        continue

    language = message.get("language")
    input_path = message.get("audioPath")
    if not isinstance(input_path, str) or not input_path:
        emit({"id": request_id, "error": "Missing input path"})
        continue

    try:
        kwargs = {}
        if isinstance(language, str) and language and language != "auto":
            kwargs["language"] = language
        segments, _ = model.transcribe(input_path, **kwargs)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        emit({"id": request_id, "text": text})
    except Exception as exc:
        emit({"id": request_id, "error": f"faster-whisper transcription failed: {exc}"})
