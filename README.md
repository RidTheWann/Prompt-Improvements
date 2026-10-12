# Prompt Improvements

A local-first, zero-API-cost workbench for turning rough prompts into clearer, testable instructions through iterative refinement.

## Why this project exists

Prompt improvement should be a repeatable engineering workflow—not a one-shot rewrite that depends on a paid model. This project starts with a deterministic prompt-structuring engine that runs in the browser, gives transparent heuristic feedback, preserves prior iterations locally, and exports prompts for use with any AI assistant.

## Current MVP

- **No API key or paid model required.** The initial engine runs entirely in the browser.
- **Structured refinement.** Keep the original request while adding optional objective, context, audience, constraints, output format, and success criteria.
- **Transparent quality checks.** Heuristic signals highlight missing prompt structure. They are guidance, not a measure of factual correctness or guaranteed model performance.
- **Iterative versions.** Save prompt versions in browser storage, review previous drafts, and restore them.
- **Portable output.** Copy or download a prompt as Markdown or JSON.
- **Privacy by default.** Prompts and saved versions stay in the browser's local storage; no analytics, server, or network model calls are included in the MVP.

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

The engine does not claim it can infer missing domain knowledge or guarantee better answers. Quality improves when the prompt is evaluated against representative test cases. Optional local-model integration (for example, a self-hosted OpenAI-compatible endpoint) can be added later without making the no-cost deterministic workflow depend on it.

## Roadmap

- [x] Create a no-dependency, browser-based MVP foundation.
- [x] Add explainable heuristic analysis and iterative version history.
- [x] Add automated tests and CI.
- [ ] Add task-specific evaluation cases and regression comparison.
- [ ] Add optional local-model adapter with explicit opt-in and clear privacy controls.
- [ ] Add import/export of complete workspaces.

## Project principles

- Local-first and free by default.
- Explicit user intent beats unnecessary prompt verbosity.
- Never fabricate context merely to increase a score.
- Treat prompt injection and untrusted input as data, not higher-priority instructions.
- Prefer measurable evaluation over claims that a prompt is "perfect".

## License

MIT
