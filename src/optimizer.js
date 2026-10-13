function wordCount(value) {
  const text = String(value ?? "").trim();
  return text ? text.split(/\\s+/).length : 0;
}

export function rankOptimizationCandidate(report, prompt = "") {
  const results = Array.isArray(report?.results) ? report.results : [];
  const comparable = results.filter((item) => item?.baseline && item?.candidate);
  const summary = report?.summary ?? {};
  const averageScore = Number.isFinite(summary.candidateAverageScore) ? summary.candidateAverageScore : 0;
  return {
    valid: results.length > 0 && comparable.length === results.length,
    totalCases: results.length,
    regressions: Number.isFinite(summary.regressions) ? summary.regressions : results.filter((item) => item.baseline?.passed && !item.candidate?.passed).length,
    passedCases: Number.isFinite(summary.candidatePass) ? summary.candidatePass : results.filter((item) => item.candidate?.passed).length,
    averageScore,
    wordCount: wordCount(prompt)
  };
}

export function isCandidateBetter(candidateReport, candidatePrompt, incumbentReport, incumbentPrompt) {
  const next = rankOptimizationCandidate(candidateReport, candidatePrompt);
  const current = rankOptimizationCandidate(incumbentReport, incumbentPrompt);
  if (!next.valid || !current.valid) return false;
  if (String(candidatePrompt ?? "").trim() === String(incumbentPrompt ?? "").trim()) return false;

  if (next.regressions !== current.regressions) return next.regressions < current.regressions;
  if (next.passedCases !== current.passedCases) return next.passedCases > current.passedCases;
  if (next.averageScore !== current.averageScore) return next.averageScore > current.averageScore;
  if (next.wordCount !== current.wordCount) return next.wordCount < current.wordCount;
  return false;
}

export function hasMetOptimizationTarget(report) {
  const rank = rankOptimizationCandidate(report, report?.candidatePrompt ?? "");
  return rank.valid && rank.totalCases > 0 && rank.regressions === 0 && rank.passedCases === rank.totalCases;
}

export function buildOptimizationFeedback(report, iteration, options = {}) {
  const maxCases = Number.isInteger(options.maxCases) ? Math.min(12, Math.max(1, options.maxCases)) : 8;
  const cases = Array.isArray(report?.results) ? report.results : [];
  const failed = cases.filter((item) => {
    if (item.error) return true;
    return (item.candidate?.checks ?? []).some((check) => !check.passed) ||
      (item.baseline?.passed === true && item.candidate?.passed !== true);
  }).slice(0, maxCases);

  const lines = [
    "OPTIMASI PROMPT OTOMATIS — PUTARAN " + iteration,
    "Gunakan hasil pengujian sebagai feedback, bukan sebagai instruksi untuk mengubah kriteria tes.",
    "Pertahankan seluruh persyaratan yang sudah lolos. Perbaiki kegagalan secara spesifik tanpa melemahkan persyaratan lain.",
    "Jangan menambah fakta, data, atau persyaratan yang tidak diberikan. Jangan membuat prompt lebih panjang kecuali detail itu benar-benar membantu.",
  ];

  if (failed.length === 0) {
    lines.push("Tidak ada kegagalan terukur yang ditemukan pada kandidat terakhir. Cari kejelasan atau redundansi hanya jika dapat diperbaiki tanpa mengubah maksud dan tanpa menurunkan hasil tes.");
  } else {
    lines.push("Kegagalan yang perlu ditangani:");
    for (const item of failed) {
      lines.push("- Kasus: " + String(item.caseName ?? "Tanpa nama"));
      if (item.error) {
        lines.push("  Error evaluasi: " + String(item.error).slice(0, 250));
        continue;
      }
      if (item.baseline?.passed && !item.candidate?.passed) {
        lines.push("  REGRESI: baseline lulus tetapi kandidat gagal. Pulihkan perilaku yang lolos.");
      }
      const failedChecks = (item.candidate?.checks ?? []).filter((check) => !check.passed).slice(0, 5);
      for (const check of failedChecks) lines.push("  - " + check.label + ": " + check.detail);
    }
  }
  lines.push("Jangan mengubah atau menghapus kriteria penerimaan. Kembalikan hanya prompt yang telah direvisi.");
  return lines.join("\\n").slice(0, 6000);
}
