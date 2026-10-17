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

test("initial copy and download actions are disabled until a prompt is generated", () => {
  assert.match(html, /id="copyButton"[^>]*disabled/);
  assert.match(html, /id="downloadButton"[^>]*disabled/);
  assert.match(app, /function updateWordCounts\(\)/);
  assert.match(app, /\$\("copyButton"\)\.disabled = !output\.trim\(\)/);
});

test("service worker cache includes the engine and adapter modules", () => {
  assert.match(serviceWorker, /prompt-improvements-v6/);
  for (const path of ["./src/app.js", "./src/prompt-engine.js", "./src/llm-client.js", "./src/templates.js"]) {
    assert.ok(serviceWorker.includes('"' + path + '"'), "missing app-shell entry " + path);
  }
});

test("privacy copy differentiates local structure mode from provider AI mode", () => {
  assert.match(html, /id="privacyModeNote"/);
  assert.match(app, /Mode gratis menyusun prompt langsung di browser/);
  assert.match(app, /Mode AI mengirim isi prompt dan konteks ke penyedia/);
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
