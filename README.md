# Prompt Improvements

A chat-first prompt builder with an adaptive deterministic engine and optional AI refinement. Send a request to see it in the conversation, follow the generation status, then copy the finished prompt. Optional tools, examples, engine settings, and history are tucked into the composer's **+** menu and a compact sidebar drawer. The default path works in the browser without an API key; advanced evaluation remains available when repeatable testing is needed.

## Why this project exists

Prompt improvement should be a repeatable engineering workflow—not a one-shot rewrite that depends on a paid model. This project starts with a deterministic prompt-structuring engine that runs in the browser, gives transparent heuristic feedback, preserves prior iterations locally, and exports prompts for use with any AI assistant.

## Current MVP

- **Free by default.** Deterministic mode runs in the browser; optional AI refinement uses your own API key.
- **Structured refinement.** Keep the original request while adding optional objective, context, audience, constraints, output format, and success criteria.
- **Transparent quality checks.** Heuristic signals highlight missing prompt structure. They are guidance, not a measure of factual correctness or guaranteed model performance.
- **Iterative versions.** Save prompt versions in browser storage, review previous drafts, and restore them.
- **Portable output.** Copy or download a prompt as Markdown or JSON.
- **Privacy by default.** Prompt versions remain in browser local storage. AI mode sends prompt text only to the provider you choose, using your own key; the app has no analytics or intermediary server.

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

## Prompt engine behavior

The deterministic engine classifies common task intents and adapts the structure instead of forcing one template onto every request. Simple tasks stay concise; complex tasks can receive tailored steps, success criteria, source-data boundaries, and conflict warnings. Scores are heuristic indicators only, not measures of factual accuracy or model quality. The engine treats missing optional details as optional and reserves clarification questions for information that would materially change the result.

The optional AI engine uses a provider-aware adapter, bounded retry for rate limits, paginated model discovery where supported, credential-scrubbed diagnostics, and response-truncation detection. Browser-to-provider requests depend on each provider's key, quota, and CORS behavior. Avoid storing API keys on shared devices and do not submit sensitive data to external providers unless authorized.

## Rujukan desain dan keamanan

- [OpenAI — Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): instruksi eksplisit, format keluaran, delimiter, serta evaluasi iteratif.
- [Anthropic — Prompt templates and variables](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables): batas konteks dan instruksi yang konsisten melalui tag yang jelas.
- [Google Gemini — Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): instruksi langsung, delimiter konsisten, dan parameter keluaran yang eksplisit.
- [OWASP — HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html): jangan menganggap browser storage sebagai tempat aman untuk kredensial.

## What "continuous improvement" means here

1. Start with one sentence or choose a starter example.
2. Generate a prompt; adding extra details is optional.
3. Review the result and copy it into your preferred AI assistant.
4. Add context or feedback only when the first result needs refinement.
5. Use advanced evaluation and saved versions when repeatable comparison matters.

The deterministic engine does not infer missing domain knowledge or guarantee better answers. AI mode adds semantic rewriting with a model you connect via API key, but its output still needs review and evaluation against representative test cases.

## Koneksi AI dengan API key

Mode **AI via API key** meminta model menulis ulang prompt-mu dengan meta-prompt rekayasa prompt (peran, delimiter data, aturan positif, format, kriteria, pemeriksaan mandiri) dan tetap menjaga fakta tidak dikarang.

1. Pilih **Mode engine → AI via API key** dan penyedia: OpenRouter (ratusan model, termasuk GPT), Anthropic, Google Gemini, atau endpoint kustom kompatibel OpenAI (wajib HTTPS; HTTP hanya untuk localhost).
2. Tempel API key lalu klik **Cek koneksi & model**; daftar model diambil langsung dari penyedia sehingga tidak ada nama model usang.
3. Klik **Sempurnakan dengan AI**.

Keamanan: request dikirim langsung dari browser ke penyedia (tanpa server perantara). API key hanya ada di memori halaman yang aktif; key tidak disimpan ke localStorage/sessionStorage dan tidak masuk ke backup atau ekspor. Setelah halaman dimuat ulang, masukkan key kembali. Skrip atau ekstensi yang berjalan di halaman tetap berpotensi mengakses key selama digunakan, jadi pakai key dengan batas pengeluaran dan hindari perangkat bersama.

Saat AI sedang streaming, mengedit prompt/pengaturan, memilih template, memulai workspace baru, atau memulihkan versi tersimpan membatalkan operasi aktif agar respons lama tidak menimpa input yang lebih baru. Tombol batal biasa tetap mempertahankan teks parsial yang sudah diterima untuk ditinjau. OpenAI langsung dari browser dapat diblokir CORS; gunakan penyedia yang mendukung akses browser atau endpoint kustom yang tepercaya. Jika koneksi gagal, mode struktur tetap bisa dipakai.

## Deploy to GitHub Pages

The repository includes a static deployment workflow. One-time setup is required because GitHub does not expose the Pages publishing source through this chat integration:

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. The workflow will publish the static app after pushes to `main`; you can also run it manually from the Actions tab.

Once the first deployment succeeds, the public app URL will be https://ridthewann.github.io/Prompt-Improvements/.

The deployment contains only the app's static frontend files. API keys never reach the deployment; AI calls go from the visitor's browser straight to the chosen provider.
## Guarded automatic prompt optimization

The **Optimasi iteratif otomatis** panel runs a bounded local search against the test cases you've written. It caches baseline outputs once per run, asks the local model to revise the best prompt using failed-check feedback, evaluates each proposal against the same baseline and criteria, and accepts it only when its rank improves. Ranking prioritizes fewer regressions, then more fully passing cases, then a higher average criteria score, then a shorter prompt. Acceptance criteria themselves are never altered.

- Select 1–3 maximum candidate-generation rounds. The runner stops early when every case passes with no regression.
- Use **Hentikan** to cancel active model work; the best candidate already evaluated remains in the editor.
- The exported evaluation JSON includes each proposed prompt, rank, whether it was accepted, and the reason for rejection/acceptance.
- Optimizing against a weak or unrepresentative suite can produce misleading results. Build diverse, realistic tests and retain human review for truthfulness, relevance, privacy, and nuanced semantics.

## Workspace backup and restore

Use **Ekspor backup** in the version-history section to save the current editor, output and safeguard settings, iteration notes, local engine/model preference, saved versions, and regression test cases in JSON. **Impor backup** validates the entire file before confirmation and replaces the current workspace. If browser storage fails, the app attempts to roll back saved data.

Backups are local files and may contain sensitive prompts, project context, saved revisions, and test inputs. Store them privately. Files are limited to 2 MiB, 50 saved versions, and 20 test cases. Evaluation run output is separate; export it from the evaluation panel when needed.

## Regression evaluation

After creating a prompt revision, add test cases that represent real tasks your prompt must handle. Each case can verify required phrases, forbidden phrases, valid JSON, required JSON keys, and a maximum word count. The suite runs the original and revised prompt against the same input and the same model, then reports pass rates, changed cases, and per-check output.

1. Connect an AI provider with your API key and select a model in the workbench (enable **Mode lanjutan**).
2. Add two or more representative test cases where practical. Use synthetic or sanitized inputs for private data.
3. Generate a revised prompt, open **Regression Tests**, and click **Jalankan evaluasi**.
4. Inspect both outputs and failed checks; export the report as JSON for a versioned record.

A higher pass rate only shows better performance on the checks you wrote. Avoid criteria that merely reward verbosity or one exact wording when multiple answers could be correct. Factuality, usefulness, safety, and nuanced semantics still need human review. Test cases are stored in the browser's local storage; evaluation outputs remain in the page session unless you export them.

## Roadmap

- [x] Create a no-dependency, browser-based MVP foundation.
- [x] Add explainable heuristic analysis and iterative version history.
- [x] Add automated tests and CI.
- [x] Add task-specific local A/B evaluation cases and regression comparison.
- [x] Add an opt-in API-key adapter (Anthropic, Gemini, OpenRouter, custom OpenAI-compatible) with live model discovery, HTTPS enforcement, and keys excluded from backups.
- [x] Strengthen the structuring engine: task-type roles, working steps, placeholder detection, clarifying-question rules, and a stronger rewrite meta-prompt.
- [x] Add validated JSON backup/restore for editor state, version history, local preferences, and regression cases.

## CI action maintenance

GitHub Actions used by CI and deployment are pinned to verified release commit SHAs rather than mutable major tags. Dependabot checks the GitHub Actions ecosystem weekly and opens update pull requests so these pins can be reviewed and kept current.

## Project principles

- Local-first and free by default.
- Explicit user intent beats unnecessary prompt verbosity.
- Never fabricate context merely to increase a score.
- Treat prompt injection and untrusted input as data, not higher-priority instructions.
- Prefer measurable evaluation over claims that a prompt is "perfect".

## License

MIT
