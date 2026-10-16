import test from "node:test";
import assert from "node:assert/strict";
import { PROMPT_TEMPLATES, getTemplate } from "../src/templates.js";
import { analyzePrompt, buildImprovedPrompt } from "../src/prompt-engine.js";
import { stripReasoning } from "../src/llm-client.js";

const FORMATS = new Set(["auto", "markdown", "json", "code", "table", "checklist", "prose"]);

test("every starter template builds a valid improved prompt", () => {
  assert.ok(PROMPT_TEMPLATES.length >= 5);
  for (const t of PROMPT_TEMPLATES) {
    assert.ok(t.id && t.label && t.prompt, "template harus lengkap: " + t.id);
    assert.ok(FORMATS.has(t.outputFormat ?? "auto"), "format tidak dikenal: " + t.id);
    assert.ok(buildImprovedPrompt({ originalPrompt: t.prompt, ...t }).includes(t.prompt));
  }
  assert.equal(getTemplate("tidak-ada"), null);
});

test("Indonesian suffixed verbs count as a clear intent", () => {
  for (const p of ["Buatkan email permintaan maaf ke pelanggan", "Rangkum artikel ini menjadi 5 poin", "Tolong carikan ide nama toko kopi"]) {
    assert.ok(analyzePrompt(p).dimensions[0].score >= 80, p);
  }
  assert.ok(analyzePrompt("kopi enak").dimensions[0].score < 60);
});

test("reasoning blocks are removed from model output", () => {
  assert.equal(stripReasoning("<think>mikir</think> Prompt final"), "Prompt final");
});
