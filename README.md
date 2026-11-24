# Black Mirror

**Your Machine. Your Models. Your Intelligence.**

Black Mirror v1.1.0 is a local LLM chat application, model library and inference server controller for Windows. It gives your existing GGUF models a fast, dark, focused interface — and keeps every inference engine independently replaceable, so the app evolves with the engine ecosystem instead of being welded to one of them.

Everything runs locally: no cloud services, no accounts, no subscriptions. Chat traffic never leaves your machine unless *you* deliberately expose it to your LAN.

---

## Highlights

| Area | What you get |
|---|---|
| **Chat** | Streaming responses with stop/regenerate, edit & resend, markdown + syntax-highlighted code with copy buttons, **tri-state thinking control** (auto / on / off — explicit disable for Ollama models that think by default), separate reasoning display, token usage, generation speed, context utilization, text & image attachments (multimodal models), conversation history with full-text search |
| **Model Library** | Recursive scan of your model directories, **import without copying**, real GGUF metadata parsing (architecture, quantization, layers, context, MoE experts), **split-shard groups** (size sums + missing-shard warnings), **multimodal projector (mmproj) pairing**, memory estimates, favorites & categories, per-model configuration profiles, live refresh |
| **Inference Engines** | llama.cpp (CPU / Vulkan / SYCL), Ollama, Lemonade — installed into an isolated folder, multiple versions side by side, independent updates, one-click rollback, custom executable paths, **capabilities probed from the binary itself** (`--help`, `--list-devices`), honest status taxonomy (available / compatible / experimental / not-installed) and hardware-compatibility reporting |
| **Servers** | Start / stop / restart / switch models, configurable port & network binding, live log viewer, duplicate-launch prevention, port-conflict detection, strict separation between Black Mirror-managed processes and externally managed ones, plus **connect-only remote OpenAI-compatible endpoints** (chat through servers you do not own) |
| **OpenAI-compatible API** | Every served model is available to other apps on `/v1/chat/completions` (streaming included), `/v1/models`, connection testing, copyable endpoints, optional LAN exposure under your control |
| **Performance** | Live CPU/RAM/committed-memory, GPU telemetry when a probe exists (honest `n/a` otherwise), managed-process memory, prompt & generation tok/s parsed from engine logs, uptime, pre-load memory assessment that warns but never blocks |
| **Benchmarks** | Real, reproducible measurements — model load time, **time to first token**, prompt processing, generation speed, total response time, peak memory — with thread / GPU-offload / context / KV-cache fields and comparability keys so only like-for-like results are compared. Saved locally, exportable. Nothing is fabricated |
| **Compatibility Lab** | Whether a model×engine×hardware×profile combination works: confirmed metadata + probed capabilities, honest six-state assessment, manual staged tests with **verified termination**, saved results with staleness tracking |
| **Diagnostics** | One-click local snapshot (app, hardware, engines, processes, ports, errors) with plain-language troubleshooting hints and local export — never transmitted |

## Screenshots

Rendered from the production UI (Electron renderer) in headless Chromium via the preview bridge — see `docs/screenshots/`:

| View | File |
|---|---|
| Chat with streaming, thinking display, token stats | `docs/screenshots/chat.png` |
| Model Library (GGUF cards, quant badges, memory estimates) | `docs/screenshots/library.png` |
| Inference Engines (status, versions, hardware panel) | `docs/screenshots/engines.png` |
| Servers (lifecycle controls, external-process safety, live logs) | `docs/screenshots/servers.png` |
| Performance (CPU/RAM/commit/GPU cards, charts, pre-load assessment) | `docs/screenshots/performance.png` |
| Benchmark Laboratory | `docs/screenshots/benchmarks.png` |
| Settings (network, defaults, diagnostics) | `docs/screenshots/settings.png` |

## Requirements

- Windows 10/11, 64-bit (development runs on Linux/macOS too)
- Node.js ≥ 18 (only for building from source; the packaged installer has no Node dependency)
- No dedicated GPU required — the default engine targets pure CPU. Designed and optimized against: **Intel Core i5-12500, 44 GB RAM, Intel UHD 770 iGPU**.

## Quick start (source)

```powershell
# 1. Install Node.js 18+ from https://nodejs.org, then:
git clone <your-repo> black-mirror
cd black-mirror
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1

# 2. Launch
npm start
```

Or double-click `scripts\setup.cmd` for a one-click setup+start.

## First run

1. **Inference Engines → Install** — fetch a llama.cpp build (CPU is the safe default; Vulkan/SYCL for your Intel iGPU if drivers allow).
2. **Model Library → Add scan directory** — point Black Mirror at your existing model folder. Files are indexed in place; nothing is copied or modified.
3. **Servers → Launch model server** — pick engine + model, review the pre-load memory assessment, launch.
4. Chat. Or point any OpenAI-compatible client at `http://127.0.0.1:8081/v1`.

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, data flow, design decisions
- [BUILD.md](docs/BUILD.md) — building, packaging, installer details
- [ENGINE_COMPATIBILITY.md](docs/ENGINE_COMPATIBILITY.md) — per-engine support matrix, hardware caveats
- [TEST_REPORT.md](docs/TEST_REPORT.md) — what was verified where, honestly categorized
- [CHANGELOG.md](docs/CHANGELOG.md)
- [TESTING](#testing) — `npm test` runs the full suite without Electron

## Testing

```bash
npm test
```

116 automated tests across 10 files (GGUF parsing + split detection, memory estimation + commit-charge assessment, model library + mmproj, engine registry & adapters + capability gating, installer + release-asset fallback, server controller + remote endpoints, ports, log parsing, conversations, config, monitor, benchmark pipeline + TTFT, streaming client) — all runnable without Electron or Windows.

## Using the OpenAI-compatible API

Every server launched from Black Mirror exposes an OpenAI-compatible API at its configured endpoint (default `http://127.0.0.1:8081/v1` — copyable in the UI):

```bash
# list models
curl http://127.0.0.1:8081/v1/models

# non-streaming completion
curl http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'

# streaming (SSE)
curl -N http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","stream":true,"messages":[{"role":"user","content":"Tell me a story"}]}'
```

No API key is required — there is no authentication by design; the default `127.0.0.1` binding keeps it private to your machine. Any OpenAI-compatible client (open-webui, LibreChat, your own code) can point at the endpoint. Note: `model` is ignored by llama.cpp servers (the loaded model answers); Ollama expects its model name from `/v1/models`.

## Privacy & safety

- Model files are **never** modified, moved or deleted — the library holds path references and metadata caches only.
- Black Mirror only ever terminates inference processes **it started itself**; externally managed Ollama/llama.cpp/lemonade processes are listed read-only and never killed.
- Uninstalling an engine version deletes only files inside `%APPDATA%\BlackMirror\engines\`.
- The API binds to `127.0.0.1` by default. Switching to `0.0.0.0` exposes it to your LAN — there is no authentication by design, and the UI says so.

## License

MIT — see [LICENSE](LICENSE).

*The intelligence changes. The mirror remains.*
