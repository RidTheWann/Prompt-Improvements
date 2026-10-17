import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inferTaskType, buildImprovedPrompt } from "../src/prompt-engine.js";
import { configureConnection, listModels } from "../src/llm-client.js";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("CSP blocks inline code, plugins, and base-tag injection", () => {
  const csp = read("index.html").match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
});

test("deployment waits for tests and stamps a unique service-worker cache id", () => {
  const deploy = read(".github/workflows/deploy.yml");
  assert.match(deploy, /needs:\s*test/);
  assert.match(deploy, /npm test/);
  assert.match(deploy, /__BUILD_ID__.*service-worker\.js/);
  const worker = read("service-worker.js");
  assert.match(worker, /prompt-improvements-__BUILD_ID__/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /Response\.error\(\)/);
  assert.ok(worker.indexOf("fetch(request)") < worker.indexOf("caches.match(request)"), "network must be tried before cache");
});

const INTENT_FIXTURES = [
  ["Write a Python function to parse CSV files and handle errors", "coding"],
  ["Write a Python function to parse CSV and return JSON", "coding"],
  ["Buatkan fungsi Python untuk membaca file CSV", "coding"],
  ["Create a SQL query to find duplicate emails", "coding"],
  ["Perbaiki bug login pada aplikasi Flask saya", "coding"],
  ["Tulis email permintaan maaf ke pelanggan karena pengiriman terlambat", "writing"],
  ["Tulis artikel blog tentang Python untuk pemula", "writing"],
  ["Rangkum artikel berikut menjadi 5 poin", "summary"],
  ["Terjemahkan teks ini ke bahasa Inggris", "translation"],
  ["Ekstrak nama dan email dari teks berikut", "extraction"],
  ["Parse the invoice text and extract the total", "extraction"],
  ["Bandingkan React dan Vue untuk proyek kecil", "analysis"],
  ["Jelaskan cara kerja blockchain untuk pemula", "learning"],
  ["Buat rencana belajar bahasa Jepang 3 bulan", "planning"],
  ["Draft a cold outreach message to a hiring manager", "writing"]
];

test("intent benchmark (reproducible fixtures)", () => {
  for (const [prompt, expected] of INTENT_FIXTURES) assert.equal(inferTaskType(prompt)?.id, expected, prompt);
});

test("already well-specified prompts are not padded with boilerplate", () => {
  const good = "Kamu adalah copywriter. Tulis 3 caption Instagram untuk toko kopi kami di Bandung, target mahasiswa, nada santai, maksimal 150 karakter, format daftar bernomor, sertakan 1 emoji.";
  const out = buildImprovedPrompt({ originalPrompt: good });
  assert.ok(out.includes(good));
  assert.ok(out.length < good.length * 3, "output " + out.length);
  assert.ok(!out.includes("## Kriteria keberhasilan"));
});

test("model discovery times out instead of hanging", async () => {
  configureConnection({ provider: "openrouter", apiKey: "k" });
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(listModels("", { timeoutMs: 30 }), /tidak merespons/);
});

test("provider requests omit credentials, referrer, and caches", async () => {
  configureConnection({ provider: "openrouter", apiKey: "k" });
  let seen;
  globalThis.fetch = async (url, options) => { seen = options; return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ id: "m" }] }) }; };
  await listModels("");
  assert.equal(seen.credentials, "omit");
  assert.equal(seen.referrerPolicy, "no-referrer");
  assert.equal(seen.cache, "no-store");
});
