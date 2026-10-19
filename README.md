# Prompt Improvements

**Prompt Improvements** is a prompt-engineering workbench: it turns a rough instruction into a clearer, more testable prompt while preserving the user’s original intent. The default **RidTheWann Core** engine runs an open-weight model locally through WebGPU to refine the prompt—not to execute or answer the task described inside it. No model API key is required for local inference.

The project also includes deterministic prompt structuring, optional hosted-model integrations, structural analysis, iterative edits, version history, and regression tests. If the browser model cannot load, the structured prompt draft remains available instead of placing an error message in the prompt output.

## What "RidTheWann Core" means

RidTheWann Core is the **project-owned prompt-refinement engine and orchestration layer**, not a claim that RidTheWann trained the underlying foundation-model weights from scratch. The initial model is **Qwen3 0.6B** with a WebLLM browser runtime. It rewrites the user’s draft prompt locally; it must not answer the underlying request.

- **Local default.** The model refines the prompt in the visitor’s browser through WebGPU and returns a copyable prompt artifact.
- **No API key for inference.** The runtime and model weights are downloaded on first use, so startup requires internet access. Later availability and caching depend on the browser.
- **Optional web search.** Search can retrieve context from Wikipedia without a key or from OpenRouter when a key and model are explicitly configured. OpenRouter search can incur charges and sends the query to that provider.
- **Privacy boundaries.** Normal prompt refinement is local. When web search is enabled, the query is sent to the selected search service. API keys stay in page memory and aren’t written to localStorage or sessionStorage.
- **Open model limits.** A 0.6B parameter model may be weaker at complex prompt design than larger hosted models. Review the refined prompt before using it.

## Why this project exists

A useful prompt-improvement tool should preserve user intent, make meaningful changes, avoid invented context, and provide measurable ways to compare revisions. RidTheWann Core adds local model-assisted refinement while keeping deterministic structuring, external models, and regression evaluation as interchangeable engines.

## Current MVP

- **Browser-local prompt refinement.** RidTheWann Core runs Qwen3 0.6B through WebLLM and returns a refined prompt instead of answering the original task.
- **Project-owned integration.** Prompt-refinement instructions, orchestration, source handling, UI, and evaluation belong to this repository; pretrained base-model weights remain upstream assets.
- **Optional web retrieval.** When enabled, web search may supply references for context-sensitive prompt work. Query routing is independent from the local model inference.
- **Deterministic prompt builder.** **Struktur lokal** produces a structured prompt instantly without downloading or running a language model.
- **Optional external model.** Use **AI via API key** when a hosted model is preferable for prompt refinement; each provider has its own quota, privacy, CORS, and cost implications.
- **Evaluation and iteration.** Analyze prompt structure, keep revisions, and compare original and revised prompts against user-defined checks. Heuristic scores are structural guidance, not measures of correctness.
- **Portable output.** Copy the refined prompt, download Markdown, save versions, or export a validated workspace backup.
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

The browser runtime is initialized on demand from a pinned WebLLM release and loads the `Qwen3-0.6B-q4f16_1-MLC` model. It stays on the client and refines the prompt in the browser. Failed runtime imports are retryable. If WebGPU, a CDN connection, model download, or browser memory prevents inference, the error appears in the status area and the deterministic structured prompt remains the output fallback—diagnostic text is never inserted as the prompt.

Web search uses a simple relevance gate. The no-key path uses Wikipedia’s public MediaWiki API and displays source links separately from the prompt output. If OpenRouter credentials/model are configured, its search tool can retrieve broader context and may incur provider charges. Retrieved pages are treated as untrusted data and are never followed as higher-priority instructions.

# Rujukan desain dan keamanan

- [OpenAI — Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): instruksi eksplisit, format keluaran, delimiter, serta evaluasi iteratif.
- [Anthropic — Prompt templates and variables](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables): batas konteks dan instruksi yang konsisten melalui tag yang jelas.
- [Google Gemini — Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): instruksi langsung, delimiter konsisten, dan parameter keluaran yang eksplisit.
- [OWASP — HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html): jangan menganggap browser storage sebagai tempat aman untuk kredensial.

## Continuous improvement

Every engine mode is designed to produce or improve a prompt, not to carry out the task described in that prompt. RidTheWann Core uses the structured draft as its starting point; if local generation fails, the draft is still available. Use the analysis, version history, and evaluation tools to check that a revision is actually better.

The local model and retrieval routing are starting points—not guarantees of strong reasoning. Use source links to verify current facts and build representative test cases before judging model changes. Larger local models, task-specific fine-tuning, and a model trained with the project's own weights are future research, not part of this initial browser deployment.

## Optional API and broader web search

The external-provider mode remains available when a larger hosted model is preferable for prompt refinement, or when you need broader OpenRouter search context before revising a prompt.

1. Open the **+** menu → **Pengaturan engine**, choose **AI via API key**, select OpenRouter (or another supported provider), and enter your API key.
2. Click **Cek koneksi & model** and select a model returned by the provider.
3. In **RidTheWann Core** mode, a configured OpenRouter key can be used only for the optional web-research step before local prompt refinement. In **AI via API key** mode, the hosted model refines the prompt itself.

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
