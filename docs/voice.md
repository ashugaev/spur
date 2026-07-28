# Voice input

Dictate prompts and messages in the web UI via the microphone button (spawn modal, session message box, terminal controls). Stays disabled until the chosen provider's dependencies are installed. `openai_compatible` is the no-install path — one key in `~/.spur/.env`.

## Server dependencies

```bash
# whisper_cpp
git clone --depth 1 https://github.com/ggerganov/whisper.cpp /tmp/whisper.cpp
cd /tmp/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)
sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli
sudo apt install -y ffmpeg   # or brew install ffmpeg — required for audio conversion
mkdir -p ~/.cache/whisper.cpp
curl -L -o ~/.cache/whisper.cpp/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# faster_whisper
python3 -m venv ~/.spur/venvs/faster-whisper
~/.spur/venvs/faster-whisper/bin/python -m pip install --upgrade pip faster-whisper

# azure_openai / openai_compatible credentials
cat >> ~/.spur/.env <<'EOF'
AZURE_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2024-10-21
GROQ_API_KEY=<key>
EOF
chmod 600 ~/.spur/.env
```

The `openai_compatible` provider talks to any vendor exposing OpenAI's `POST /audio/transcriptions` shape. Set `voice.baseUrl`, `voice.apiKey` (the env-var name, not the secret), and put the key in `~/.spur/.env`:

| Vendor     | `voice.baseUrl`                  | `voice.apiKey`       | Example `voice.model`    |
| ---------- | -------------------------------- | -------------------- | ------------------------ |
| Groq       | `https://api.groq.com/openai/v1` | `GROQ_API_KEY`       | `whisper-large-v3-turbo` |
| OpenAI     | `https://api.openai.com/v1`      | `OPENAI_API_KEY`     | `whisper-1`              |
| OpenRouter | `https://openrouter.ai/api/v1`   | `OPENROUTER_API_KEY` | vendor-specific model id |

## Config

In `~/.spur/config.yaml`:

```yaml
voice:
  provider: whisper_cpp # default: whisper_cpp
  language: auto # default: auto
  model: base # default: base
  # modelPath: ~/.cache/whisper.cpp/ggml-base.bin  # optional override
```

- `voice.provider`: `whisper_cpp|faster_whisper|azure_openai|openai_compatible`, default `whisper_cpp`.
- `voice.language`: transcription language code, default `auto`. `whisper_cpp` passes it as `-l <code>`; `faster_whisper` uses it as a hint.
- `voice.model`: model name, default `base`. For `azure_openai` it is the deployment name; for `openai_compatible` the vendor model id.
- `voice.modelPath`: local model path; overrides `voice.model` when set.
- `voice.baseUrl`: required for `openai_compatible`.
- `voice.apiKey`: env-var name holding the key (`^[A-Z][A-Z0-9_]*$`), resolved from `~/.spur/.env` then `process.env`; never logged. Required for `openai_compatible`, optional for `azure_openai` (defaults to `AZURE_OPENAI_API_KEY`).
- `voice.endpoint`: optional for `azure_openai`; falls back to env `AZURE_OPENAI_ENDPOINT`.
- `voice.apiVersion`: optional for `azure_openai`; falls back to env `AZURE_OPENAI_API_VERSION`, then `2024-10-21`.

Spur auto-detects `~/.spur/venvs/faster-whisper/bin/python` and uses `int8` by default for that worker. Isolated daemons inherit `voice:` from `~/.spur/config.yaml`; a relative `voice.modelPath` resolves against the user config dir.

## HTTPS

Browsers require HTTPS for microphone access (`getUserMedia`); `localhost` works over plain HTTP. For remote access via Tailscale (substitute your tailnet):

```bash
sudo tailscale serve --bg --https 443 http://127.0.0.1:5555
# https://<hostname>.<your-tailnet>.ts.net/ — reachable only within the tailnet
# disable: tailscale serve --https=443 off
```
