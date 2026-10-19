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


test("model discovery follows Gemini pagination and removes duplicate model IDs", async () => {
  configureConnection({ provider: "gemini", apiKey: "g-key" });
  const model = (name) => ({ name: "models/" + name, supportedGenerationMethods: ["generateContent"] });
  const calls = mockFetch((url) => url.includes("pageToken=page-2")
    ? ok({ models: [model("gem-b"), model("gem-a")] })
    : ok({ models: [model("gem-a")], nextPageToken: "page-2" }));

  assert.deepEqual(await listModels(""), ["gem-a", "gem-b"]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("pageToken=page-2"));
});

test("Anthropic model discovery follows a bounded before_id cursor", async () => {
  configureConnection({ provider: "anthropic", apiKey: "sk-test" });
  const calls = mockFetch((url) => url.includes("before_id=claude-1")
    ? ok({ data: [{ id: "claude-2" }], has_more: false })
    : ok({ data: [{ id: "claude-1" }], has_more: true }));

  assert.deepEqual(await listModels(""), ["claude-1", "claude-2"]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("before_id=claude-1"));
});

test("provider transport retries a transient 503 only once", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  let attempts = 0;
  const calls = mockFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return { ok: false, status: 503, headers: new Headers({ "retry-after": "0" }), json: async () => ({}) };
    }
    return ok({ data: [{ id: "model-a" }] });
  });

  assert.deepEqual(await listModels(""), ["model-a"]);
  assert.equal(calls.length, 2);
});

test("rate-limit retry observes abort signals instead of waiting indefinitely", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const controller = new AbortController();
  const calls = mockFetch(() => ({
    ok: false,
    status: 429,
    headers: new Headers({ "retry-after": "5" }),
    json: async () => ({ error: { message: "rate limited" } })
  }));
  const abortTimer = setTimeout(() => controller.abort(), 15);
  try {
    await assert.rejects(listModels("", { signal: controller.signal }), (error) => error?.name === "AbortError");
    assert.equal(calls.length, 1);
  } finally {
    clearTimeout(abortTimer);
  }
});

test("truncated model output gives a clear recovery message", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  mockFetch(() => ok({ choices: [{ message: { content: "Incomplete prompt" }, finish_reason: "length" }] }));
  await assert.rejects(
    improvePromptWithAI({ baseUrl: "", model: "model-a", originalPrompt: "Buat rencana", structuredDraft: "draft" }),
    /Output model terpotong/
  );
});

test("provider error details do not disclose bearer credentials", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  mockFetch(() => ({
    ok: false,
    status: 500,
    headers: new Headers(),
    json: async () => ({ error: { message: "upstream failed for Bearer sk-12345678901234567890 api_key=topsecret" } })
  }));
  await assert.rejects(listModels(""), (error) => {
    assert.match(error.message, /upstream failed/);
    assert.doesNotMatch(error.message, /sk-12345678901234567890|topsecret/);
    return true;
  });
});

function sseResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event + "\n\n"));
      }
      controller.close();
    }
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream,
    json: async () => { throw new Error("Stream response should not call json()"); }
  };
}

test("OpenAI/OpenRouter SSE streaming invokes onChunk and accumulates text", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const chunks = [];
  const calls = mockFetch(() => sseResponse([
    'data: {"choices":[{"delta":{"content":"Halo "}}]}',
    'data: {"choices":[{"delta":{"content":"dunia!"}}]}',
    'data: [DONE]'
  ]));
  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "test-model",
    originalPrompt: "test",
    structuredDraft: "draft",
    onChunk: (chunk, acc) => chunks.push({ chunk, acc })
  });
  assert.equal(result, "Halo dunia!");
  assert.equal(calls[0].options.headers.Accept, "text/event-stream, application/json");
  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.stream, true);
  assert.deepEqual(chunks, [
    { chunk: "Halo ", acc: "Halo " },
    { chunk: "dunia!", acc: "Halo dunia!" }
  ]);
});

test("Anthropic SSE streaming parses content_block_delta text", async () => {
  configureConnection({ provider: "anthropic", apiKey: "sk-ant" });
  const chunks = [];
  const calls = mockFetch(() => sseResponse([
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'data: {"type":"message_stop"}'
  ]));
  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "claude-3",
    originalPrompt: "test",
    structuredDraft: "draft",
    onChunk: (chunk, acc) => chunks.push({ chunk, acc })
  });
  assert.equal(result, "Claude stream");
  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.stream, true);
  assert.deepEqual(chunks, [
    { chunk: "Claude ", acc: "Claude " },
    { chunk: "stream", acc: "Claude stream" }
  ]);
});

test("Gemini SSE streaming uses correct stream endpoint and parses candidate parts", async () => {
  configureConnection({ provider: "gemini", apiKey: "g-key" });
  const chunks = [];
  const calls = mockFetch(() => sseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"streaming"}]}}]}'
  ]));
  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "gem-model",
    originalPrompt: "test",
    structuredDraft: "draft",
    onChunk: (chunk, acc) => chunks.push({ chunk, acc })
  });
  assert.equal(result, "Gemini streaming");
  assert.ok(calls[0].url.includes(":streamGenerateContent?alt=sse"));
  assert.deepEqual(chunks, [
    { chunk: "Gemini ", acc: "Gemini " },
    { chunk: "streaming", acc: "Gemini streaming" }
  ]);
});

test("Streaming respects abort signal and terminates immediately", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let cancelledStream = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Awal..."}}]}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Lanjutan"}}]}\n\n'));
      ctrl.close();
    },
    cancel() {
      cancelledStream = true;
    }
  });
  mockFetch(() => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream,
    json: async () => ({})
  }));

  const abortTimer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      improvePromptWithAI({
        baseUrl: "",
        model: "m",
        originalPrompt: "x",
        structuredDraft: "y",
        signal: controller.signal,
        onChunk: () => {}
      }),
      (err) => err?.name === "AbortError"
    );
    assert.equal(cancelledStream, true);
  } finally {
    clearTimeout(abortTimer);
  }
});

test("improvePromptWithAI with onChunk falls back cleanly if body is non-streaming", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const chunks = [];
  mockFetch(() => ok({ choices: [{ message: { content: "Hasil non-stream" } }] }));
  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "m",
    originalPrompt: "x",
    structuredDraft: "y",
    onChunk: (chunk, acc) => chunks.push({ chunk, acc })
  });
  assert.equal(result, "Hasil non-stream");
  assert.deepEqual(chunks, [{ chunk: "Hasil non-stream", acc: "Hasil non-stream" }]);
});

test("Streaming catches finish_reason length and raises actionable error", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  mockFetch(() => sseResponse([
    'data: {"choices":[{"delta":{"content":"Sebagian teks"},"finish_reason":"length"}]}'
  ]));
  await assert.rejects(
    improvePromptWithAI({
      baseUrl: "",
      model: "m",
      originalPrompt: "x",
      structuredDraft: "y",
      onChunk: () => {}
    }),
    /Output model terpotong karena batas token/
  );
});


test("SSE parser handles irregular byte boundaries, CRLF, and split UTF-8 characters", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const received = [];
  const payload = new TextEncoder().encode([
    'data: {"choices":[{"delta":{"content":"Halo 🌏"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":" dunia"}}]}\r\n\r\n',
    "data: [DONE]\r\n\r\n"
  ].join(""));
  const chunks = [];
  for (let offset = 0; offset < payload.length;) {
    const size = (offset % 7) + 1;
    chunks.push(payload.slice(offset, offset + size));
    offset += size;
  }
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  mockFetch(() => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream
  }));

  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "byte-chunks",
    originalPrompt: "test",
    structuredDraft: "draft",
    onChunk: (chunk, accumulated) => received.push({ chunk, accumulated })
  });
  assert.equal(result, "Halo 🌏 dunia");
  assert.equal(received.at(-1).accumulated, "Halo 🌏 dunia");
});

test("SSE [DONE] sentinel stops reading even if the provider leaves the stream open", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Complete"}}]}\n\ndata: [DONE]\n\n'));
    },
    cancel() {
      cancelled = true;
    }
  });
  mockFetch(() => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream
  }));

  let timeout;
  try {
    const result = await Promise.race([
      improvePromptWithAI({
        baseUrl: "",
        model: "sentinel",
        originalPrompt: "test",
        structuredDraft: "draft",
        onChunk: () => {}
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Stream did not finish after [DONE]")), 150);
      })
    ]);
    assert.equal(result, "Complete");
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
  }
});


test("OpenRouter reasoning and web search are sent as explicit controls and source links are surfaced", async () => {
  configureConnection({ provider: "openrouter", apiKey: "or-key" });
  const sources = [];
  const calls = mockFetch(() => ok({
    choices: [{
      message: {
        content: "Tulis prompt final",
        annotations: [{
          type: "url_citation",
          url_citation: { url: "https://docs.example.dev/reference", title: "Official reference" }
        }]
      }
    }]
  }));
  const result = await improvePromptWithAI({
    baseUrl: "",
    model: "reasoning-model",
    originalPrompt: "Bantu audit API",
    structuredDraft: "draft",
    reasoningEffort: "high",
    webSearch: true,
    onSources: (items) => sources.push(...items)
  });
  assert.equal(result, "Tulis prompt final");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.tools, [{
    type: "openrouter:web_search",
    parameters: { max_uses: 3, max_total_results: 8, search_context_size: "medium" }
  }]);
  assert.deepEqual(sources, [{
    url: "https://docs.example.dev/reference",
    title: "Official reference",
    domain: "docs.example.dev"
  }]);
  assert.equal(Object.hasOwn(body, "include_reasoning"), false, "private reasoning must not be requested as a visible response field");
  assert.equal(Object.hasOwn(body, "reasoning_details"), false, "private reasoning metadata is not surfaced as user-facing chat content");
});

test("web search cannot silently be enabled for non-OpenRouter providers", async () => {
  configureConnection({ provider: "gemini", apiKey: "g-key" });
  const calls = mockFetch(() => ok({}));
  await assert.rejects(
    improvePromptWithAI({
      baseUrl: "",
      model: "gemini-test",
      originalPrompt: "Improve this",
      structuredDraft: "draft",
      webSearch: true
    }),
    /hanya tersedia melalui penyedia OpenRouter/
  );
  assert.equal(calls.length, 0, "unsupported web search must fail before a provider request is sent");
});
