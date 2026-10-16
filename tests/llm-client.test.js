import test from "node:test";
import assert from "node:assert/strict";
import { configureConnection, listModels, improvePromptWithAI, normalizeEndpoint, validateEndpointUrl, createImprovementMessages } from "../src/llm-client.js";
import { buildImprovedPrompt, findMissingInfo } from "../src/prompt-engine.js";

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return handler(url, options); };
  return calls;
}
const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

test("endpoint validation enforces HTTPS and blocks credentials", () => {
  assert.equal(validateEndpointUrl(" https://api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(validateEndpointUrl("http://localhost:1234/v1"), "http://localhost:1234/v1");
  assert.throws(() => validateEndpointUrl("http://api.example.com/v1"), /wajib HTTPS/);
  assert.throws(() => validateEndpointUrl("https://u:p@api.example.com"), /kredensial/);
  configureConnection({ provider: "anthropic" });
  assert.equal(normalizeEndpoint("https://evil.example"), "https://api.anthropic.com");
});

test("Anthropic request carries key headers and parses text blocks", async () => {
  configureConnection({ provider: "anthropic", apiKey: "sk-test" });
  const calls = mockFetch(() => ok({ content: [{ type: "text", text: "<think>x</think>Prompt baru" }] }));
  const text = await improvePromptWithAI({ baseUrl: "", model: "claude-x", originalPrompt: "Tulis email", structuredDraft: "draft", settings: {} });
  assert.equal(text, "Prompt baru");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].options.headers["x-api-key"], "sk-test");
  assert.equal(calls[0].options.headers["anthropic-dangerous-direct-browser-access"], "true");
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.system.includes("prompt engineer") && body.max_tokens > 0 && body.messages[0].role === "user");
});

test("Gemini and OpenAI-compatible providers use their own shapes", async () => {
  configureConnection({ provider: "gemini", apiKey: "g-key" });
  let calls = mockFetch(() => ok({ models: [{ name: "models/gem-a", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }));
  assert.deepEqual(await listModels(""), ["gem-a"]);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "g-key");
  calls = mockFetch(() => ok({ candidates: [{ content: { parts: [{ text: "Hasil Gemini" }] } }] }));
  assert.equal(await improvePromptWithAI({ baseUrl: "", model: "gem-a", originalPrompt: "x", structuredDraft: "y" }), "Hasil Gemini");
  assert.ok(calls[0].url.endsWith("/models/gem-a:generateContent"));
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  calls = mockFetch(() => ok({ choices: [{ message: { content: "Hasil OR" } }] }));
  assert.equal(await improvePromptWithAI({ baseUrl: "", model: "m/x", originalPrompt: "x", structuredDraft: "y" }), "Hasil OR");
  assert.equal(calls[0].options.headers.Authorization, "Bearer or-key");
});

test("missing key, rejected key, and CORS failures give actionable errors", async () => {
  configureConnection({ provider: "openrouter", apiKey: "" });
  await assert.rejects(listModels(""), /API key/);
  configureConnection({ apiKey: "bad" });
  mockFetch(() => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { message: "no" } }) }));
  await assert.rejects(listModels(""), /API key ditolak/);
  mockFetch(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(listModels(""), /CORS/);
});

test("rewrite meta-prompt and engine add roles, steps, placeholders, and clarification rules", () => {
  const system = createImprovementMessages({ originalPrompt: "x" })[0].content;
  assert.match(system, /never execute|Never execute/);
  const built = buildImprovedPrompt({ originalPrompt: "Buatkan [fitur] dengan Python untuk aplikasi saya" });
  assert.match(built, /## Peran/);
  assert.match(built, /## Langkah kerja/);
  assert.match(built, /## Placeholder[\s\S]*\[fitur\]/);
  assert.match(built, /pertanyaan klarifikasi/);
  assert.ok(findMissingInfo("Tulis email ke [nama]", {}).length >= 2);
});
