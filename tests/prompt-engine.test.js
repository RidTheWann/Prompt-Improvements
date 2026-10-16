import test from "node:test";
import assert from "node:assert/strict";
import { analyzePrompt, buildImprovedPrompt, createExportPayload } from "../src/prompt-engine.js";

test("empty prompt returns a zero score and actionable empty-state dimensions", () => {
  const result = analyzePrompt("   ");
  assert.equal(result.score, 0);
  assert.equal(result.wordCount, 0);
  assert.equal(result.dimensions.length, 6);
  assert.ok(result.dimensions.every((dimension) => dimension.score === 0));
});

test("analysis score is a rounded average of the six transparent dimensions", () => {
  const result = analyzePrompt("Buat API untuk pengguna", {
    context: "Aplikasi internal menggunakan Python",
    constraints: "Jangan gunakan dependency berbayar",
    outputFormat: "json",
    successCriteria: "Test case harus lulus"
  });
  const expected = Math.round(result.dimensions.reduce((sum, item) => sum + item.score, 0) / 6);
  assert.equal(result.score, expected);
  assert.equal(result.dimensions.length, 6);
  assert.ok(result.score >= 0 && result.score <= 100);
});

test("improved prompt preserves the original request exactly", () => {
  const originalPrompt = "Buat REST API untuk mengelola data pengguna.";
  const result = buildImprovedPrompt({ originalPrompt });
  assert.ok(result.includes("## Permintaan asli\n" + originalPrompt));
  assert.ok(result.endsWith("\n"));
});

test("optional context, audience, constraints, and selected output format are included", () => {
  const result = buildImprovedPrompt({
    originalPrompt: "Buat API",
    objective: "Membantu tim membuat layanan CRUD.",
    context: "Backend memakai Python dan SQLite.",
    audience: "Developer pemula",
    constraints: "Tanpa layanan berbayar\nPertahankan endpoint lama",
    outputFormat: "json",
    successCriteria: "Semua test case valid"
  });
  assert.ok(result.includes("## Tujuan tambahan\nMembantu tim membuat layanan CRUD."));
  assert.ok(result.includes("## Konteks\nBackend memakai Python dan SQLite."));
  assert.ok(result.includes("## Target audiens\nDeveloper pemula"));
  assert.ok(result.includes("- Tanpa layanan berbayar"));
  assert.ok(result.includes("- Pertahankan endpoint lama"));
  assert.ok(result.includes("Keluarkan JSON yang valid saja."));
  assert.ok(result.includes("- Semua test case valid"));
});

test("empty optional fields do not create empty sections", () => {
  const result = buildImprovedPrompt({ originalPrompt: "Jelaskan konsep API dengan contoh." });
  assert.ok(!result.includes("## Konteks\n\n"));
  assert.ok(!result.includes("## Tujuan tambahan\n\n"));
});

test("iteration notes accumulate without replacing the original request", () => {
  const result = buildImprovedPrompt({
    originalPrompt: "Review kode ini.",
    iterationNotes: ["Tambahkan test unit.", "Jangan ubah public API."]
  });
  assert.ok(result.includes("## Permintaan asli\nReview kode ini."));
  assert.ok(result.includes("- Tambahkan test unit."));
  assert.ok(result.includes("- Jangan ubah public API."));
});

test("safeguards can be deliberately disabled", () => {
  const result = buildImprovedPrompt({
    originalPrompt: "Buat ringkasan.",
    safeguards: { preserveIntent: false, avoidFabrication: false, review: false }
  });
  assert.ok(!result.includes("Pertahankan maksud permintaan asli"));
  assert.ok(!result.includes("Jangan menyajikan asumsi"));
  assert.ok(!result.includes("Lakukan pemeriksaan akhir"));
});

test("JSON export uses a versioned schema and preserves prompt content", () => {
  const payload = createExportPayload({
    originalPrompt: "Buat ringkasan.",
    settings: { outputFormat: "markdown" },
    improvedPrompt: "# Prompt",
    analysis: { score: 70, dimensions: [{ id: "intent", score: 70 }] },
    iterationNotes: ["Lebih ringkas"]
  });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.originalPrompt, "Buat ringkasan.");
  assert.equal(payload.analysis.score, 70);
  assert.deepEqual(payload.iterationNotes, ["Lebih ringkas"]);
  assert.ok(Array.isArray(payload.limitations));
});

test("building without a prompt fails with an actionable message", () => {
  assert.throws(() => buildImprovedPrompt({ originalPrompt: "" }), /Prompt awal wajib diisi/);
});
