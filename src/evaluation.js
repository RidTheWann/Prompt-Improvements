function splitTerms(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(/[\\n,]/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeEvaluationCase(input = {}) {
  const name = String(input.name ?? "").trim();
  const testInput = String(input.input ?? "").trim();
  const requiredText = splitTerms(input.requiredText);
  const forbiddenText = splitTerms(input.forbiddenText);
  const requiredKeys = splitTerms(input.requiredKeys);
  const requireJson = input.requireJson === true;
  const rawMaxWords = input.maxWords;
  const maxWords = rawMaxWords === "" || rawMaxWords === null || rawMaxWords === undefined
    ? null
    : Number(rawMaxWords);

  if (!name) throw new Error("Nama test case wajib diisi.");
  if (name.length > 120) throw new Error("Nama test case maksimal 120 karakter.");
  if (!testInput) throw new Error("Input uji wajib diisi.");
  if (testInput.length > 12000) throw new Error("Input uji maksimal 12.000 karakter.");
  if (requiredText.length > 12 || forbiddenText.length > 12 || requiredKeys.length > 12) {
    throw new Error("Maksimal 12 item untuk setiap daftar kriteria.");
  }
  if (rawMaxWords !== "" && rawMaxWords !== null && rawMaxWords !== undefined &&
      (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 10000)) {
    throw new Error("Batas kata harus berupa angka bulat antara 1 dan 10.000.");
  }
  if (!requireJson && requiredKeys.length > 0) {
    throw new Error("Aktifkan pemeriksaan JSON jika kamu menetapkan key JSON wajib.");
  }
  if (!requireJson && requiredText.length === 0 && forbiddenText.length === 0 && maxWords === null) {
    throw new Error("Tambahkan minimal satu kriteria terukur: teks wajib, teks terlarang, JSON valid, atau batas kata.");
  }

  return {
    id: typeof input.id === "string" && input.id ? input.id : "",
    name,
    input: testInput,
    requiredText,
    forbiddenText,
    requireJson,
    requiredKeys,
    maxWords
  };
}

function countWords(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.split(/\\s+/).length : 0;
}

export function scoreEvaluationOutput(output, testCase) {
  const text = String(output ?? "");
  const normalized = normalizeEvaluationCase({
    ...testCase,
    name: testCase.name || "Evaluation case",
    input: testCase.input || "(empty test input)"
  });
  const checks = [];
  const add = (id, label, passed, detail) => checks.push({ id, label, passed: Boolean(passed), detail });
  add("non_empty", "Output tidak kosong", text.trim().length > 0, text.trim() ? "Output diterima." : "Model mengembalikan output kosong.");

  let parsed = null;
  let jsonValid = false;
  if (normalized.requireJson) {
    try {
      parsed = JSON.parse(text);
      jsonValid = parsed !== null && (typeof parsed === "object");
    } catch {
      jsonValid = false;
    }
    add("valid_json", "JSON valid", jsonValid, jsonValid ? "Output berhasil diparse sebagai JSON." : "Output bukan JSON valid atau bukan objek/array JSON.");
  }
  if (normalized.requiredKeys.length > 0) {
    const hasObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    const missing = normalized.requiredKeys.filter((key) => !hasObject || !Object.hasOwn(parsed, key));
    add("required_keys", "Key JSON wajib", missing.length === 0, missing.length === 0 ? "Semua key wajib tersedia." : "Key yang hilang: " + missing.join(", "));
  }
  normalized.requiredText.forEach((term, index) => {
    const passed = text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
    add("required_text_" + index, "Harus mengandung: " + term, passed, passed ? "Teks ditemukan." : "Teks tidak ditemukan.");
  });
  normalized.forbiddenText.forEach((term, index) => {
    const passed = !text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
    add("forbidden_text_" + index, "Tidak boleh mengandung: " + term, passed, passed ? "Teks terlarang tidak ditemukan." : "Teks terlarang ditemukan.");
  });
  if (normalized.maxWords !== null) {
    const words = countWords(text);
    const passed = words <= normalized.maxWords;
    add("max_words", "Maksimal " + normalized.maxWords + " kata", passed, "Output berisi " + words + " kata.");
  }

  const passedChecks = checks.filter((check) => check.passed).length;
  return {
    score: checks.length ? Math.round((passedChecks / checks.length) * 100) : 0,
    passed: checks.length > 0 && passedChecks === checks.length,
    passedChecks,
    totalChecks: checks.length,
    wordCount: countWords(text),
    checks,
    output: text
  };
}

export function summarizeEvaluationRun(results) {
  const cases = Array.isArray(results) ? results : [];
  const baselinePass = cases.filter((item) => item.baseline?.passed === true).length;
  const candidatePass = cases.filter((item) => item.candidate?.passed === true).length;
  const comparable = cases.filter((item) => item.baseline && item.candidate);
  const regressions = comparable.filter((item) => item.baseline.passed && !item.candidate.passed).length;
  const improvements = comparable.filter((item) => !item.baseline.passed && item.candidate.passed).length;
  const average = (side) => {
    const valid = cases.map((item) => item[side]?.score).filter((score) => Number.isFinite(score));
    return valid.length ? Math.round(valid.reduce((sum, score) => sum + score, 0) / valid.length) : null;
  };
  return {
    totalCases: cases.length,
    baselinePass,
    candidatePass,
    regressions,
    improvements,
    baselineAverageScore: average("baseline"),
    candidateAverageScore: average("candidate"),
    passRateDelta: cases.length ? Math.round(((candidatePass - baselinePass) / cases.length) * 100) : 0
  };
}

export function createEvaluationReport(options = {}) {
  return {
    schemaVersion: 1,
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    model: options.model ?? null,
    baselinePrompt: options.baselinePrompt ?? "",
    candidatePrompt: options.candidatePrompt ?? "",
    summary: summarizeEvaluationRun(options.results ?? []),
    results: (options.results ?? []).map((item) => ({
      caseId: item.caseId,
      caseName: item.caseName,
      baseline: item.baseline ?? null,
      candidate: item.candidate ?? null,
      error: item.error ?? null
    })),
    limitations: [
      "Deterministic checks measure only the criteria configured for each test case; they do not establish factual correctness or overall semantic quality.",
      "Baseline and candidate were evaluated sequentially with the same local model; generation can still vary by model implementation.",
      "Use representative inputs and human review for requirements that cannot be expressed as deterministic checks."
    ]
  };
}
