# Prompt Improvements

A local-first, zero-API-cost workbench for turning rough prompts into clearer, testable instructions through iterative refinement.

## Why this project exists

Prompt improvement should be a repeatable engineering workflow—not a one-shot rewrite that depends on a paid model. This project starts with a deterministic prompt-structuring engine that runs in the browser, gives transparent heuristic feedback, preserves prior iterations locally, and exports prompts for use with any AI assistant.

## Current MVP

- **No paid API required.** Deterministic mode runs in the browser; optional semantic refinement uses a model installed locally through Ollama.
- **Structured refinement.** Keep the original request while adding optional objective, context, audience, constraints, output format, and success criteria.
- **Transparent quality checks.** Heuristic signals highlight missing prompt structure. They are guidance, not a measure of factual correctness or guaranteed model performance.
- **Iterative versions.** Save prompt versions in browser storage, review previous drafts, and restore them.
- **Portable output.** Copy or download a prompt as Markdown or JSON.
- **Privacy by default.** Prompt versions remain in browser local storage. AI mode sends prompt text only to a loopback Ollama endpoint on your own computer; the app has no cloud inference integration or analytics.

## Run locally

Use any static HTTP server from the repository root. For example, with Python installed:

```bash
python -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080).

You can also deploy the static site to GitHub Pages. No build step or dependency installation is required for the app itself.

## Test the prompt engine

The project uses Node.js built-in test runner and has no runtime dependencies:

```bash
npm test
```

## What "continuous improvement" means here

1. Start with a rough prompt.
2. Inspect the structural analysis and identify weak dimensions.
3. Add only the context and constraints that genuinely apply.
4. Generate a structured version and compare it with the original.
5. Save an iteration, test it against real tasks, and refine it again.

The deterministic engine does not infer missing domain knowledge or guarantee better answers. Ollama mode adds semantic rewriting with a local model, but its output still needs review and evaluation against representative test cases.

## AI lokal dengan Ollama

AI mode memberi revisi semantik menggunakan model yang berjalan di komputermu. Tidak memerlukan API key atau biaya per token, tetapi model perlu diunduh dan pemrosesan memakai sumber daya perangkat.

1. Install Ollama dari https://ollama.com/download.
2. Unduh model yang ingin dipakai. Contoh: `ollama pull qwen3:8b`.
3. Pastikan Ollama berjalan; endpoint lokal default adalah `http://localhost:11434`.
4. Jalankan web app dengan server lokal seperti yang dijelaskan di atas, lalu klik **Cek koneksi & model** dan pilih model yang terpasang.
5. Ubah **Mode engine** menjadi **AI lokal · Ollama**, lalu klik **Sempurnakan dengan AI lokal**.

### Jika aplikasi dibuka dari GitHub Pages

Browser dapat memblokir permintaan lintas-origin. Ollama menerima origin lokal secara default; untuk situs publik, tambahkan origin situs ke `OLLAMA_ORIGINS` lalu restart Ollama. Gunakan hanya origin yang kamu percaya. Contoh untuk repo ini: `https://ridthewann.github.io` (origin tidak menyertakan `/Prompt-Improvements`). Lihat [panduan CORS resmi Ollama](https://github.com/ollama/ollama/blob/main/docs/faq.mdx#how-can-i-allow-additional-web-origins-to-access-ollama).

Endpoint yang diterima UI dibatasi ke `localhost`, `127.0.0.1`, dan `::1`; alamat remote ditolak supaya prompt tidak tanpa sengaja dikirim ke layanan eksternal. Jika koneksi gagal, mode struktur deterministik tetap dapat digunakan.
## Roadmap

- [x] Create a no-dependency, browser-based MVP foundation.
- [x] Add explainable heuristic analysis and iterative version history.
- [x] Add automated tests and CI.
- [ ] Add task-specific evaluation cases and regression comparison.
- [x] Add an opt-in local Ollama adapter, loopback-only endpoint validation, model discovery, and clear privacy controls.
- [ ] Add import/export of complete workspaces.

## Project principles

- Local-first and free by default.
- Explicit user intent beats unnecessary prompt verbosity.
- Never fabricate context merely to increase a score.
- Treat prompt injection and untrusted input as data, not higher-priority instructions.
- Prefer measurable evaluation over claims that a prompt is "perfect".

## License

MIT
