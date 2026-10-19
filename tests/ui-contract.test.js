import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

test("every static application DOM ID reference exists exactly once", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const idSet = new Set(ids);
  const references = [...new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]))];
  assert.equal(ids.length, idSet.size, "HTML must not contain duplicate IDs");
  const missing = references.filter((id) => !idSet.has(id));
  assert.deepEqual(missing, [], "static ID references must be present in index.html");
});

test("beginner flow uses progressive disclosure and an obvious primary action", () => {
  assert.match(html, /Apa yang ingin kamu minta kepada AI\?/);
  assert.match(html, /id="contextDetails"/);
  assert.match(html, /id="engineSettings"/);
  assert.match(html, /id="analysisDetails"/);
  assert.match(html, /id="iterationDetails"/);
  assert.match(html, /id="improveButton"[^>]*class="[^"]*button-primary/);
  for (const details of html.matchAll(/<details\b([^>]*)>/g)) {
    assert.doesNotMatch(details[1], /\bopen\b/, "advanced details should start collapsed");
  }
});

test("chat-first flow hides the result until generation finishes", () => {
  assert.match(html, /id="assistantThinking"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="thinkingMessage"/);
  assert.match(html, /id="outputPanel"[^>]*hidden/);
  assert.match(app, /function beginAssistantTurn\(originalPrompt, message\)/);
  assert.match(app, /function revealOutputPanel\(\)/);
  assert.match(app, /\$\("assistantThinking"\)\.hidden = true/);
});

test("optional tools and examples live in the composer plus menu without template emojis", () => {
  assert.match(html, /id="composerPlusButton"[^>]*aria-controls="composerMenu"/);
  assert.match(html, /id="composerMenu"[^>]*hidden/);
  assert.match(html, /data-composer-action="engine"/);
  assert.match(html, /data-composer-action="history"/);
  assert.match(app, /chip\.textContent = item\.label;/);
  assert.doesNotMatch(app, /chip\.textContent = item\.icon \+/);
  assert.match(app, /function toggleComposerMenu\(force\)/);
});

test("the desktop sidebar starts as an off-canvas drawer rather than taking chat width", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-sidebar \{[\s\S]*?position: fixed;[\s\S]*?transform: translateX\(-105%\)/);
  assert.match(app, /sidebar\.inert = !open/);
});

test("AI stream cancellation prevents stale results from replacing newer workspace state", () => {
  assert.match(app, /function invalidateActiveAiOperation\(reason, notify = false\)/);
  assert.match(app, /operationId !== activeAiOperationId/);
  assert.match(app, /invalidateActiveAiOperation\("Workspace baru dibuka"\)/);
  assert.match(app, /invalidateActiveAiOperation\("Versi riwayat dipulihkan"\)/);
});

test("score card provides before and after comparison indicators for user content", () => {
  assert.match(html, /id="scoreBeforeValue"/);
  assert.match(html, /id="scoreValue"/);
  assert.match(html, /Menilai isi pengguna, bukan boilerplate/);
  assert.match(app, /\$\("scoreBeforeValue"\)/);
});

test("initial copy and download actions are disabled until a prompt is generated", () => {
  assert.match(html, /id="copyButton"[^>]*disabled/);
  assert.match(html, /id="downloadButton"[^>]*disabled/);
  assert.match(app, /function updateWordCounts\(\)/);
  assert.match(app, /\$\("copyButton"\)\.disabled = !output\.trim\(\)/);
});

test("service worker cache includes the engine and adapter modules", () => {
  assert.match(serviceWorker, /prompt-improvements-__BUILD_ID__/);
  for (const path of ["./src/app.js", "./src/prompt-engine.js", "./src/llm-client.js", "./src/local-ai.js", "./src/web-search.js", "./src/templates.js"]) {
    assert.ok(serviceWorker.includes('"' + path + '"'), "missing app-shell entry " + path);
  }
});

test("privacy copy differentiates local structure mode from provider AI mode", () => {
  assert.match(html, /id="privacyModeNote"/);
  assert.match(app, /Mode struktur gratis menyusun prompt/);
  assert.match(app, /Mode API mengirim isi prompt dan konteks/);
  assert.match(app, /RidTheWann Core menjawab langsung/);
});


test("API keys are memory-only and never persisted in browser storage", async () => {
  assert.doesNotMatch(html, /id="llmRemember"/);
  assert.match(html, /key-memory-note/);
  assert.match(app, /clearLegacyApiKeys\(\)/);
  assert.doesNotMatch(app, /(?:localStorage|sessionStorage)\.setItem\((?:KEY_SESSION|KEY_PERSIST)/);
});


test("legacy key storage constants initialize before AI config bootstrap", () => {
  const keysAt = app.indexOf('const KEY_SESSION = "prompt-improvements.api-key.session";');
  const configAt = app.indexOf("let llmConfig = loadLlmConfig();");
  assert.ok(keysAt >= 0 && keysAt < configAt, "legacy credential cleanup constants must be initialized before loading AI settings");
});

test("streaming AI response provides a cancel button in the primary actions", () => {
  assert.match(html, /id="cancelImproveButton"[^>]*hidden[^>]*disabled/);
  assert.match(html, /id="cancelImproveButton"[^>]*button-danger-subtle/);
  assert.match(app, /\$\("cancelImproveButton"\)/);
  assert.match(app, /function cancelAiImprovement\(\)/);
});


test("the composer clears sent text while the assistant response renders like a chat message", () => {
  assert.match(html, /id="assistantReplyIntro" class="assistant-reply-intro"/);
  assert.match(html, /id="promptPreview" class="prompt-preview"/);
  assert.match(html, /id="improvedPrompt"[^>]*hidden/);
  assert.match(html, /id="editPromptButton"/);
  assert.match(app, /function beginAssistantTurn\(originalPrompt, message\)[\s\S]*?\$\("originalPrompt"\)\.value = ""/);
  assert.match(app, /function renderPromptPreview\(\)/);
  assert.match(app, /function renderWebSources\(sources\)/);
});

test("OpenRouter reasoning and web search controls are persistent, explicit, and provider-aware", () => {
  assert.match(html, /id="reasoningEffort"/);
  assert.match(html, /id="webSearchEnabled"[^>]*checked/);
  assert.match(html, /id="reasoningHelp"/);
  assert.match(app, /function loadReasoningPrefs\(\)/);
  assert.match(app, /reasoningEffort,\s*webSearch,/);
  assert.match(app, /const supported = \$\("llmProvider"\)\.value === "openrouter"/);
});


test("RidTheWann Core is the default browser-local answer engine", () => {
  assert.match(html, /<option value="local-ai" selected>RidTheWann Core/);
  assert.match(html, /id="localModelPanel"/);
  assert.match(html, /id="loadLocalModelButton"/);
  assert.match(html, /id="conversationArchive"/);
  assert.match(app, /async function runLocalAssistantTurn\(originalPrompt, settings\)/);
  assert.match(app, /generateLocalAssistantReply\(/);
  assert.match(app, /researchWebWithOpenRouter\(/);
  assert.match(app, /searchWikipedia\(/);
  assert.match(app, /$("engineMode").value === "local-ai"/);
});

test("GitHub Pages allows the pinned browser inference runtime and WebGPU workers", () => {
  assert.match(html, /script-src[^"]*https:\/\/esm\.run[^"]*wasm-unsafe-eval/);
  assert.match(html, /worker-src[^"]*blob:/);
});
