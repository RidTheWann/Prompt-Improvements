# Prompt Improvements

**RidTheWann Core** is the default, browser-local chat engine in this project. It runs an open-weight language model through WebGPU, can answer ordinary questions, maintains short-lived conversation context, and can retrieve web context when useful. No model API key is required for local inference.

Prompt Improvements also retains a deterministic prompt-structuring workflow and optional external provider integrations. The UI is chat-first: submitted text leaves the composer, previous local turns remain visible for the current session, and the current reply can be copied or edited.

## What "RidTheWann Core" means

RidTheWann Core is the **project-owned assistant engine and orchestration layer**, not a claim that RidTheWann trained the underlying foundation-model weights from scratch. The initial inference model is **Qwen3 0.6B** with a WebLLM browser runtime. This gives the project a model that executes locally in a supported browser, rather than outsourcing every answer to an API.

- **Local default.** The selected model generates answers in the visitor's browser through WebGPU.
- **No API key for inference.** The runtime and model weights must be downloaded on first use, so first startup requires an internet connection. Subsequent availability and caching depend on the browser.
- **Optional web search.** The app can query Wikipedia's MediaWiki search API without a key. If a user explicitly configures a valid OpenRouter model and key, the app can also ask OpenRouter's web-search tool for broader search results; this part can incur provider charges and sends the query to that provider.
- **Privacy boundaries.** Local prompts are passed to the local model in the browser. A web-search query is sent to the selected search service. API keys are held only in page memory and aren't written to localStorage or sessionStorage.
- **Open model limits.** A 0.6B parameter model is intentionally small and may be weaker at complex reasoning, long context, coding, and factual detail than larger hosted models. Review important answers and sources.

## Why this project exists

A useful personal AI should have a stable identity, usable chat flow, local inference, safe tool routing, and measurable behavior—not just a dropdown for a hosted model. RidTheWann Core begins with a small open-weight model and a controlled browser runtime, while keeping prompt structuring, external models, and regression evaluation available as interchangeable capabilities.

## Current MVP

- **Browser-local assistant.** RidTheWann Core runs Qwen3 0.6B through WebLLM with WebGPU and answers the user's underlying request directly.
- **Open model + project identity.** The system instructions, chat orchestration, source handling, and UI belong to this repository; the base model weights remain upstream open-weight assets.
- **Web retrieval.** Search-relevant questions can retrieve Wikipedia snippets and links. With OpenRouter configured, a separate web-search request may provide broader results before the local model writes the answer.
- **Conversation continuity.** A bounded in-memory conversation window supports follow-up messages. Starting a new workspace clears the current chat context.
- **Deterministic prompt builder.** Switch to **Struktur lokal** to generate a structured prompt without running a language model.
- **Optional external model.** Use **AI via API key** for hosted-model output or prompt refinement; each provider has its own quota, privacy, CORS, and cost implications.
- **Evaluation and iteration.** Advanced tests compare original and revised prompts against user-defined checks. Heuristic scores are structural guidance, not measures of truth.
- **Portable output.** Copy the current answer or prompt, download Markdown, save versions, or export a validated workspace backup.
- **No-server deployment.** The GitHub Pages app is static; model inference is performed in the visitor's browser. No API key or server secret is embedded in the repository.

## Run locally

Use any static HTTP server from the repository root. For example, with Python:

```bash
python -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080). Model inference requires a browser with WebGPU support. First-time runtime and model downloads need an internet connection; the deterministic builder remains available even without a compatible GPU.

## Test the project

The project uses Node.js's built-in test runner:

```bash
npm test
```

The tests validate local prompt assembly, web-search sanitization, backup validation, API routing, and UI contracts. They do not download the full model or prove inference quality; browser smoke tests keep their normal flow in deterministic mode.

## Local-model behavior

The browser runtime is initialized on demand from a pinned WebLLM release and loads the `Qwen3-0.6B-q4f16_1-MLC` model. The model stays on the client and generates token streams in the browser. If WebGPU is unavailable, model download fails, or the browser runs out of memory, the app reports an error and the deterministic or external API modes remain available.

Web search uses a simple relevance gate to avoid searching for every message. The no-key path uses Wikipedia's public MediaWiki API and displays source links separately from the answer. If OpenRouter credentials/model are configured, its server-side search tool can be used for broader retrieval; that request is independent from the local inference pass. The app does not claim an answer is verified merely because a search was attempted.

# Rujukan desain dan keamanan

- [OpenAI — Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): instruksi eksplisit, format keluaran, delimiter, serta evaluasi iteratif.
- [Anthropic — Prompt templates and variables](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables): batas konteks dan instruksi yang konsisten melalui tag yang jelas.
- [Google Gemini — Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): instruksi langsung, delimiter konsisten, dan parameter keluaran yang eksplisit.
- [OWASP — HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html): jangan menganggap browser storage sebagai tempat aman untuk kredensial.

## Continuous improvement

The local AI path answers the underlying request directly; it doesn't automatically rewrite every message as a prompt. Switch to **Struktur lokal** when you specifically want a prompt artifact, add task context when it materially helps, and use the advanced evaluation tools when repeatable comparisons matter.

The local model and retrieval routing are starting points—not guarantees of strong reasoning. Use source links to verify current facts and build representative test cases before judging model changes. Larger local models, task-specific fine-tuning, and a model trained with the project's own weights are future research, not part of this initial browser deployment.

## Optional API and broader web search

The external-provider mode remains available when a larger hosted model is preferable, or when you want broader OpenRouter web search before the local model drafts its answer.

1. Open the **+** menu → **Pengaturan engine**, choose **AI via API key**, select OpenRouter (or another supported provider), and enter your API key.
2. Click **Cek koneksi & model** and select a model returned by the provider.
3. In **RidTheWann Core** mode, a configured OpenRouter key can be used only for the optional web-research step. In **AI via API key** mode, the hosted model itself generates the output.

Keys exist only in the active page's memory and are not included in backups or exported files. They are removed when the page reloads. Use provider spending limits, avoid shared devices, and don't send sensitive data to any external search/provider.

## Deploy to GitHub Pages

The repository deploys as a static frontend. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions** if this repository hasn't been configured yet. After a successful workflow run, the public app URL is https://ridthewann.github.io/Prompt-Improvements/.

GitHub Pages does not host a private inference API or train model weights. Inference occurs in the visitor's supported browser. WebLLM runtime/model files are fetched from their configured public asset hosts on first load, and Wikipedia/OpenRouter search requests go directly from the browser to those services when invoked.

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
