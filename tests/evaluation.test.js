import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvaluationCase, scoreEvaluationOutput, summarizeEvaluationRun, createEvaluationReport, serializeEvaluationReport } from "../src/evaluation.js";

test("test cases require actionable input and at least one measurable criterion", () => {
  assert.throws(() => normalizeEvaluationCase({ name: "", input: "data", requiredText: ["ok"] }), /Nama test case wajib/);
  assert.throws(() => normalizeEvaluationCase({ name: "Missing input", input: "  ", requiredText: ["ok"] }), /Input uji wajib/);
  assert.throws(() => normalizeEvaluationCase({ name: "No checks", input: "data" }), /minimal satu kriteria/);
});

test("test case validator bounds input, criteria count, and word count", () => {
  assert.throws(() => normalizeEvaluationCase({ name: "Big input", input: "x".repeat(12001), requiredText: ["x"] }), /12.000 karakter/);
  assert.throws(() => normalizeEvaluationCase({ name: "Too many terms", input: "x", requiredText: Array(13).fill("x") }), /Maksimal 12/);
  assert.throws(() => normalizeEvaluationCase({ name: "Bad word count", input: "x", maxWords: 0 }), /angka bulat/);
  assert.throws(() => normalizeEvaluationCase({ name: "Keys need JSON", input: "x", requiredKeys: ["a"], requiredText: ["a"] }), /Aktifkan pemeriksaan JSON/);
});

test("evaluator measures required and forbidden text case-insensitively", () => {
  const testCase = normalizeEvaluationCase({
    name: "Text checks", input: "demo", requiredText: ["Hello", "WORLD"], forbiddenText: ["secret"]
  });
  const good = scoreEvaluationOutput("Hello world, this is safe.", testCase);
  const bad = scoreEvaluationOutput("hello world secret.", testCase);
  assert.equal(good.passed, true);
  assert.equal(good.score, 100);
  assert.equal(bad.passed, false);
  assert.equal(bad.checks.find((item) => item.id === "forbidden_text_0").passed, false);
});

test("evaluator parses JSON, checks keys, and enforces maximum words", () => {
  const testCase = normalizeEvaluationCase({
    name: "JSON schema", input: "return object", requireJson: true, requiredKeys: ["summary", "risks"], maxWords: 12
  });
  const good = scoreEvaluationOutput(JSON.stringify({ summary: "A short summary", risks: [] }), testCase);
  const invalid = scoreEvaluationOutput('{"summary": "missing close"', testCase);
  const missingKey = scoreEvaluationOutput(JSON.stringify({ summary: "only one" }), testCase);
  assert.equal(good.passed, true);
  assert.equal(good.score, 100);
  assert.equal(invalid.checks.find((item) => item.id === "valid_json").passed, false);
  assert.equal(missingKey.checks.find((item) => item.id === "required_keys").passed, false);
});

test("evaluator catches empty output and word limit failures", () => {
  const testCase = normalizeEvaluationCase({ name: "Short response", input: "sample", requiredText: ["ok"], maxWords: 2 });
  const result = scoreEvaluationOutput("This output has many words and lacks the expected value.", testCase);
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((item) => item.id === "max_words").passed, false);
  assert.equal(scoreEvaluationOutput("", testCase).checks[0].passed, false);
});

test("suite summary detects improvements, regressions, pass rates and mean scores", () => {
  const results = [
    { baseline: { passed: true, score: 100 }, candidate: { passed: true, score: 100 } },
    { baseline: { passed: true, score: 100 }, candidate: { passed: false, score: 50 } },
    { baseline: { passed: false, score: 50 }, candidate: { passed: true, score: 100 } },
    { baseline: { passed: false, score: 0 }, candidate: { passed: false, score: 50 } }
  ];
  const summary = summarizeEvaluationRun(results);
  assert.equal(summary.totalCases, 4);
  assert.equal(summary.baselinePass, 2);
  assert.equal(summary.candidatePass, 2);
  assert.equal(summary.regressions, 1);
  assert.equal(summary.improvements, 1);
  assert.equal(summary.passRateDelta, 0);
  assert.equal(summary.baselineAverageScore, 63);
  assert.equal(summary.candidateAverageScore, 75);
});

test("evaluation report keeps prompts and per-case outcomes exportable", () => {
  const report = createEvaluationReport({
    model: "qwen3:8b", baselinePrompt: "old", candidatePrompt: "new",
    results: [{ caseId: "1", caseName: "A", baseline: { score: 50, passed: false }, candidate: { score: 100, passed: true } }]
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.model, "qwen3:8b");
  assert.equal(report.summary.improvements, 1);
  assert.equal(report.baselinePrompt, "old");
  assert.equal(report.results[0].candidate.score, 100);
  assert.ok(report.limitations.length >= 2);
});

test("newline-delimited criteria stay as whole terms", () => {
  const testCase = normalizeEvaluationCase({
    name: "Newline terms", input: "sample", requiredText: "first phrase\nsecond phrase"
  });
  assert.deepEqual(testCase.requiredText, ["first phrase", "second phrase"]);
});

test("evaluation report serialization emits parseable JSON with a final newline", () => {
  const report = createEvaluationReport({
    model: "local-model",
    results: [{ caseId: "case-1", caseName: "Serialize", baseline: { score: 50, passed: false }, candidate: { score: 100, passed: true } }]
  });
  const serialized = serializeEvaluationReport(report);
  assert.ok(serialized.endsWith("\n"));
  assert.doesNotThrow(() => JSON.parse(serialized));
});

import { rankOptimizationCandidate, isCandidateBetter, hasMetOptimizationTarget, buildOptimizationFeedback } from "../src/optimizer.js";

function sampleReport({ baselinePass = 0, candidatePass = 0, regressions = 0, average = 0, total = 2 } = {}) {
  const results = Array.from({ length: total }, (_, index) => ({
    caseName: "Case " + index,
    baseline: { passed: index < baselinePass, score: index < baselinePass ? 100 : 0, checks: [] },
    candidate: {
      passed: index < candidatePass,
      score: index < candidatePass ? 100 : average,
      checks: [{ id: "check", label: "Required contract", passed: index < candidatePass, detail: index < candidatePass ? "OK" : "Missing required output" }],
      output: "test"
    }
  }));
  return {
    candidatePrompt: "candidate",
    summary: { regressions, candidatePass, candidateAverageScore: average },
    results
  };
}

test("optimizer ranks full valid reports and rejects incomplete evaluations", () => {
  const valid = sampleReport({ baselinePass: 1, candidatePass: 1, average: 70 });
  const rank = rankOptimizationCandidate(valid, "one two three");
  assert.equal(rank.valid, true);
  assert.equal(rank.regressions, 0);
  assert.equal(rank.passedCases, 1);
  assert.equal(rank.wordCount, 3);
  assert.equal(rankOptimizationCandidate({ results: [] }, "prompt").valid, false);
});

test("optimizer prefers fewer regressions before maximizing passes", () => {
  const clean = sampleReport({ baselinePass: 1, candidatePass: 1, regressions: 0, average: 50 });
  const regressed = sampleReport({ baselinePass: 1, candidatePass: 2, regressions: 1, average: 100 });
  assert.equal(isCandidateBetter(clean, "a clean candidate", regressed, "a regressed candidate"), true);
});

test("optimizer prefers more passing cases and then higher scores without regressions", () => {
  const fewerPasses = sampleReport({ baselinePass: 0, candidatePass: 1, regressions: 0, average: 50 });
  const morePasses = sampleReport({ baselinePass: 0, candidatePass: 2, regressions: 0, average: 40 });
  const lowerAverage = sampleReport({ baselinePass: 0, candidatePass: 2, regressions: 0, average: 60 });
  assert.equal(isCandidateBetter(morePasses, "stronger prompt", fewerPasses, "weaker prompt"), true);
  assert.equal(isCandidateBetter(lowerAverage, "stronger prompt v2", morePasses, "stronger prompt"), true);
  assert.equal(isCandidateBetter(morePasses, "same prompt", morePasses, "same prompt"), false);
});

test("optimizer stops early when every case passes without regression", () => {
  const done = sampleReport({ baselinePass: 1, candidatePass: 2, regressions: 0, average: 100 });
  assert.equal(hasMetOptimizationTarget(done), true);
  const regression = sampleReport({ baselinePass: 2, candidatePass: 2, regressions: 1, average: 100 });
  assert.equal(hasMetOptimizationTarget(regression), false);
});

test("optimizer feedback targets failed checks without weakening acceptance criteria", () => {
  const report = {
    results: [{
      caseName: "Strict JSON",
      baseline: { passed: true },
      candidate: { passed: false, checks: [{ passed: false, label: "JSON valid", detail: "Parse failed" }] }
    }]
  };
  const feedback = buildOptimizationFeedback(report, 2);
  assert.match(feedback, /Putaran 2/);
  assert.match(feedback, /REGRESI/);
  assert.match(feedback, /JSON valid/);
  assert.match(feedback, /Jangan mengubah atau menghapus kriteria penerimaan/);
});

test("optimizer feedback uses actual line breaks and is bounded", async () => {
  const { buildOptimizationFeedback } = await import("../src/optimizer.js");
  const feedback = buildOptimizationFeedback({
    results: [{
      caseName: "Strict JSON",
      baseline: { passed: true },
      candidate: { passed: false, checks: [{ passed: false, label: "JSON valid", detail: "Parse failed" }] }
    }]
  }, 2);
  assert.ok(feedback.includes("\nOPTIMASI PROMPT OTOMATIS"), "feedback should contain separated sections");
  assert.ok(!feedback.includes("\\nOPTIMASI"), "feedback must not have literal slash-n separators");
  assert.ok(feedback.length <= 6000);
});
