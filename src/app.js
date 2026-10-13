import { analyzePrompt, buildImprovedPrompt, createExportPayload } from "./prompt-engine.js";
import { improvePromptWithOllama, listLocalModels, normalizeOllamaBaseUrl, runPromptTaskWithOllama } from "./ollama-client.js";
import { normalizeEvaluationCase, scoreEvaluationOutput, summarizeEvaluationRun, createEvaluationReport, serializeEvaluationReport } from "./evaluation.js";
import { rankOptimizationCandidate, isCandidateBetter, hasMetOptimizationTarget, buildOptimizationFeedback } from "./optimizer.js";
import { createWorkspaceBackup, parseWorkspaceBackup, MAX_WORKSPACE_FILE_CHARS } from "./workspace.js";

const STORAGE_KEY = "prompt-improvements.history.v1";
const OLLAMA_CONFIG_KEY = "prompt-improvements.ollama.v1";
const EVAL_CASES_KEY = "prompt-improvements.eval-cases.v1";
const MAX_EVAL_CASES = 20;
const MAX_HISTORY = 50;
const $ = (id) => document.getElementById(id);

let savedVersions = loadHistory();
let lastAnalysis = null;
let iterationNotes = [];
let toastTimer = null;
let ollamaConfig = loadOllamaConfig();
let ollamaModels = [];
let evaluationCases = loadEvaluationCases();
let latestEvaluationReport = null;
let activeOptimizationController = null;

const fields = [
  "originalPrompt",
  "objective",
  "context",
  "audience",
  "constraints",
  "outputFormat",
  "successCriteria"
];
const ruleIds = ["ruleIntent", "ruleGrounding", "ruleReview"];

function readSettings() {
  return {
    objective: $("objective").value.trim(),
    context: $("context").value.trim(),
    audience: $("audience").value.trim(),
    constraints: $("constraints").value.trim(),
    outputFormat: $("outputFormat").value,
    successCriteria: $("successCriteria").value.trim(),
    safeguards: {
      preserveIntent: $("ruleIntent").checked,
      avoidFabrication: $("ruleGrounding").checked,
      review: $("ruleReview").checked
    },
    iterationNotes: [...iterationNotes]
  };
}

function loadHistory() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((item) =>
      item && typeof item.id === "string" &&
      typeof item.originalPrompt === "string" &&
      typeof item.improvedPrompt === "string"
    ).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}


function loadOllamaConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(OLLAMA_CONFIG_KEY) || "{}");
    return { baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : "http://localhost:11434", model: typeof stored.model === "string" ? stored.model : "" };
  } catch {
    return { baseUrl: "http://localhost:11434", model: "" };
  }
}

function saveOllamaConfig() {
  ollamaConfig = { baseUrl: $("ollamaEndpoint").value.trim() || "http://localhost:11434", model: $("ollamaModel").value.trim() };
  try { localStorage.setItem(OLLAMA_CONFIG_KEY, JSON.stringify(ollamaConfig)); }
  catch { showToast("Pengaturan Ollama tidak bisa disimpan oleh browser. Kamu tetap bisa melanjutkan sesi ini."); }
}

function setOllamaStatus(message, tone = "neutral") {
  const status = $("ollamaStatus");
  status.textContent = message;
  status.dataset.tone = tone;
}

function populateOllamaModels(models, preferredModel = "") {
  const select = $("ollamaModel");
  select.replaceChildren();
  ollamaModels = [...models];
  if (models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Tidak ada model terpasang";
    select.append(option);
    select.value = "";
    return;
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }
  select.value = models.includes(preferredModel) ? preferredModel : models[0];
  ollamaConfig.model = select.value;
}

function initializeOllamaSettings() {
  $("ollamaEndpoint").value = ollamaConfig.baseUrl;
  if (ollamaConfig.model) {
    const option = document.createElement("option");
    option.value = ollamaConfig.model;
    option.textContent = ollamaConfig.model + " (belum diverifikasi)";
    $("ollamaModel").append(option);
    $("ollamaModel").value = ollamaConfig.model;
  }
  updateEngineLabel();
}

function updateEngineLabel() {
  const useOllama = $("engineMode").value === "ollama";
  $("improveButtonText").textContent = useOllama ? "Sempurnakan dengan AI lokal" : "Perbaiki prompt";
  if (useOllama) setOllamaStatus("Mode AI dipilih. Cek koneksi dan pilih model lokal terlebih dahulu.");
  else if (ollamaModels.length > 0) setOllamaStatus(ollamaModels.length + " model lokal terdeteksi.", "success");
  else setOllamaStatus("Mode struktur tetap bisa dipakai tanpa Ollama.");
}

async function checkOllamaConnection() {
  const button = $("checkOllamaButton");
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Memeriksa...";
  setOllamaStatus("Menghubungi server lokal...");
  try {
    const baseUrl = normalizeOllamaBaseUrl($("ollamaEndpoint").value);
    const models = await listLocalModels(baseUrl);
    ollamaConfig.baseUrl = baseUrl;
    populateOllamaModels(models, ollamaConfig.model);
    saveOllamaConfig();
    if (models.length === 0) {
      setOllamaStatus("Ollama terhubung, tetapi belum ada model. Unduh model melalui terminal terlebih dahulu.", "error");
      showToast("Ollama terhubung, tetapi belum ada model lokal.");
      return;
    }
    setOllamaStatus("Terhubung · " + models.length + " model lokal tersedia.", "success");
    showToast("Koneksi berhasil. Pilih model untuk penyempurnaan AI lokal.");
  } catch (error) {
    setOllamaStatus(error instanceof Error ? error.message : "Koneksi Ollama gagal.", "error");
    showToast(error instanceof Error ? error.message : "Koneksi Ollama gagal.");
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function runSelectedEngine() {
  const originalPrompt = currentOriginal();
  if (!originalPrompt) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return;
  }
  const settings = readSettings();
  const analysis = analyzePrompt(originalPrompt, settings);
  let deterministicDraft;
  try { deterministicDraft = buildImprovedPrompt({ originalPrompt, ...settings }); }
  catch (error) {
    showToast(error instanceof Error ? error.message : "Prompt tidak dapat disusun.");
    return;
  }
  renderAnalysis(analysis);

  if ($("engineMode").value !== "ollama") {
    $("improvedPrompt").value = deterministicDraft;
    updateWordCounts();
    $("resultStatus").textContent = iterationNotes.length ? "Iterasi " + iterationNotes.length : "Prompt disusun";
    showToast(iterationNotes.length
      ? "Iterasi struktur diperbarui. Prompt awal dan seluruh catatan tetap dipertahankan."
      : "Prompt terstruktur berhasil dibuat. Tinjau dan sesuaikan sebelum digunakan.");
    return;
  }

  const previousOutput = $("improvedPrompt").value.trim();
  const draftToImprove = iterationNotes.length > 0 && previousOutput ? previousOutput : deterministicDraft;
  const button = $("improveButton");
  const previousButtonLabel = $("improveButtonText").textContent;
  let controller;
  let timeoutId;
  button.disabled = true;
  $("improveButtonText").textContent = "AI lokal sedang bekerja...";
  $("resultStatus").textContent = "Mengirim prompt ke model lokal...";
  setOllamaStatus("Model sedang memproses di komputer ini. Waktu respons bergantung pada model dan perangkat.");
  try {
    const baseUrl = normalizeOllamaBaseUrl($("ollamaEndpoint").value);
    const model = $("ollamaModel").value.trim();
    if (!model || !ollamaModels.includes(model)) {
      throw new Error("Cek koneksi dan pilih model yang terpasang sebelum memakai AI lokal.");
    }
    saveOllamaConfig();
    controller = new AbortController();
    timeoutId = window.setTimeout(() => controller.abort(), 240000);
    const refinedPrompt = await improvePromptWithOllama({
      baseUrl, model, originalPrompt, structuredDraft: draftToImprove, settings, signal: controller.signal
    });
    $("improvedPrompt").value = refinedPrompt;
    $("resultStatus").textContent = iterationNotes.length ? "Iterasi AI " + iterationNotes.length : "AI lokal selesai";
    updateWordCounts();
    setOllamaStatus("Selesai · prompt diproses oleh model lokal.", "success");
    showToast("Prompt disempurnakan oleh AI lokal. Periksa hasil sebelum digunakan.");
  } catch (error) {
    $("resultStatus").textContent = "AI lokal gagal";
    const message = error?.name === "AbortError"
      ? "Permintaan dihentikan setelah 4 menit. Coba model yang lebih kecil atau prompt yang lebih ringkas."
      : error instanceof Error ? error.message : "AI lokal gagal menyempurnakan prompt.";
    setOllamaStatus(message, "error");
    if (!$("improvedPrompt").value.trim()) {
      $("improvedPrompt").value = deterministicDraft;
      updateWordCounts();
    }
    showToast(message);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    button.disabled = false;
    $("improveButtonText").textContent = previousButtonLabel;
  }
}


function loadEvaluationCases() {
  try {
    const raw = JSON.parse(localStorage.getItem(EVAL_CASES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_EVAL_CASES).map((item) => normalizeEvaluationCase(item)).map((item, index) => ({
      ...item,
      id: raw[index]?.id || makeId()
    }));
  } catch {
    return [];
  }
}

function persistEvaluationCases() {
  try {
    localStorage.setItem(EVAL_CASES_KEY, JSON.stringify(evaluationCases));
  } catch {
    showToast("Browser tidak dapat menyimpan test case. Ekspor hasil atau kurangi jumlah data.");
  }
}

function splitEvaluationTerms(value) {
  return String(value ?? "").split(/[\n,]/).map((term) => term.trim()).filter(Boolean);
}

function addEvaluationCase() {
  if (evaluationCases.length >= MAX_EVAL_CASES) {
    showToast("Maksimal " + MAX_EVAL_CASES + " test case. Hapus kasus yang tidak dipakai untuk menambah yang baru.");
    return;
  }
  try {
    const item = normalizeEvaluationCase({
      id: makeId(),
      name: $("evalCaseName").value,
      input: $("evalInput").value,
      requiredText: splitEvaluationTerms($("evalRequired").value),
      forbiddenText: splitEvaluationTerms($("evalForbidden").value),
      requireJson: $("evalRequireJson").checked,
      requiredKeys: splitEvaluationTerms($("evalRequiredKeys").value),
      maxWords: $("evalMaxWords").value || null
    });
    item.id = makeId();
    if (evaluationCases.some((existing) => existing.name.toLocaleLowerCase() === item.name.toLocaleLowerCase())) {
      throw new Error("Nama test case sudah digunakan. Gunakan nama yang unik.");
    }
    evaluationCases.push(item);
    persistEvaluationCases();
    renderEvaluationCases();
    $("evalCaseName").value = "";
    $("evalInput").value = "";
    $("evalRequired").value = "";
    $("evalForbidden").value = "";
    $("evalRequireJson").checked = false;
    $("evalRequiredKeys").value = "";
    $("evalMaxWords").value = "";
    showToast("Test case disimpan secara lokal.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Test case tidak dapat ditambahkan.");
  }
}

function renderEvaluationCases() {
  const list = $("evalCaseList");
  list.replaceChildren();
  $("evalCaseCount").textContent = evaluationCases.length + (evaluationCases.length === 1 ? " kasus" : " kasus");
  if (evaluationCases.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "◎";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Suite masih kosong";
    const description = document.createElement("p");
    description.textContent = "Buat test case pertama yang sesuai dengan tugas prompt kamu.";
    copy.append(title, description);
    empty.append(icon, copy);
    list.append(empty);
    return;
  }

  for (const item of evaluationCases) {
    const card = document.createElement("article");
    card.className = "eval-case-card";
    const head = document.createElement("div");
    head.className = "eval-case-card-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const preview = document.createElement("p");
    preview.textContent = item.input.slice(0, 220) + (item.input.length > 220 ? "…" : "");
    copy.append(title, preview);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "eval-case-remove";
    remove.textContent = "Hapus";
    remove.dataset.evalAction = "delete";
    remove.dataset.id = item.id;
    remove.setAttribute("aria-label", "Hapus test case " + item.name);
    head.append(copy, remove);
    const chips = document.createElement("div");
    chips.className = "eval-case-rules";
    const rules = [];
    if (item.requireJson) rules.push("JSON valid");
    if (item.requiredKeys.length) rules.push(item.requiredKeys.length + " key wajib");
    if (item.requiredText.length) rules.push(item.requiredText.length + " teks wajib");
    if (item.forbiddenText.length) rules.push(item.forbiddenText.length + " teks terlarang");
    if (item.maxWords !== null) rules.push("maks. " + item.maxWords + " kata");
    for (const rule of rules) {
      const chip = document.createElement("span");
      chip.className = "eval-rule-chip";
      chip.textContent = rule;
      chips.append(chip);
    }
    card.append(head, chips);
    list.append(card);
  }
}

function appendCheckList(target, result) {
  const list = document.createElement("ul");
  list.className = "eval-check-list";
  for (const check of (result?.checks ?? [])) {
    const item = document.createElement("li");
    if (check.passed) item.className = "ok";
    item.textContent = check.label + " — " + check.detail;
    list.append(item);
  }
  target.append(list);
}

function appendOutputDetails(target, label, output) {
  if (!output) return;
  const details = document.createElement("details");
  details.className = "eval-output-details";
  const summary = document.createElement("summary");
  summary.textContent = "Lihat output model: " + label;
  const pre = document.createElement("pre");
  pre.textContent = output;
  details.append(summary, pre);
  target.append(details);
}

function renderEvaluationResults(report) {
  const summaryBox = $("evalResultSummary");
  const list = $("evalResultList");
  list.replaceChildren();
  summaryBox.hidden = false;
  const s = report.summary;
  summaryBox.replaceChildren();
  const main = document.createElement("div");
  main.textContent = "Baseline lulus " + s.baselinePass + "/" + s.totalCases +
    " kasus (rata-rata " + (s.baselineAverageScore ?? "—") + "%); revisi lulus " +
    s.candidatePass + "/" + s.totalCases + " kasus (rata-rata " +
    (s.candidateAverageScore ?? "—") + "%).";
  const delta = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = "Perubahan pass rate: " + (s.passRateDelta > 0 ? "+" : "") + s.passRateDelta + " poin persentase.";
  delta.append(strong);
  const regressions = document.createElement("div");
  regressions.textContent = "Regresi: " + s.regressions + " · Perbaikan kasus: " + s.improvements + ".";
  summaryBox.append(main, delta, regressions);

  for (const item of report.results) {
    const card = document.createElement("article");
    card.className = "eval-result-card";
    const head = document.createElement("div");
    head.className = "eval-result-head";
    const title = document.createElement("strong");
    title.textContent = item.caseName;
    const badge = document.createElement("span");
    const candidatePass = item.candidate?.passed === true;
    badge.className = "eval-result-badge " + (candidatePass ? "pass" : "fail");
    badge.textContent = item.error ? "ERROR" : candidatePass ? "LULUS" : "PERLU DITINJAU";
    head.append(title, badge);
    const body = document.createElement("div");
    body.className = "eval-result-body";

    if (item.error) {
      const error = document.createElement("div");
      error.className = "eval-error";
      error.textContent = item.error;
      body.append(error);
    } else {
      const grid = document.createElement("div");
      grid.className = "eval-comparison";
      for (const [label, result] of [["Baseline", item.baseline], ["Prompt revisi", item.candidate]]) {
        const side = document.createElement("section");
        side.className = "eval-side";
        const sideHead = document.createElement("div");
        sideHead.className = "eval-side-head";
        const name = document.createElement("span");
        name.textContent = label;
        const score = document.createElement("span");
        score.className = "eval-side-score";
        score.textContent = (result?.score ?? "—") + "%";
        sideHead.append(name, score);
        const content = document.createElement("div");
        content.className = "eval-side-content";
        appendCheckList(content, result);
        appendOutputDetails(content, label, result?.output);
        side.append(sideHead, content);
        grid.append(side);
      }
      body.append(grid);
    }
    card.append(head, body);
    list.append(card);
  }
  $("downloadEvaluationButton").disabled = report.results.length === 0;
}

async function runEvaluationSuite() {
  const originalPrompt = currentOriginal();
  const candidatePrompt = $("improvedPrompt").value.trim();
  if (!originalPrompt) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return;
  }
  if (!candidatePrompt) {
    showToast("Susun prompt hasil revisi sebelum membandingkannya.");
    $("improvedPrompt").focus();
    return;
  }
  if (evaluationCases.length === 0) {
    showToast("Tambahkan setidaknya satu test case terlebih dahulu.");
    $("evalCaseName").focus();
    return;
  }
  const button = $("runEvaluationButton");
  const originalLabel = button.textContent;
  let completed = [];
  button.disabled = true;
  $("autoOptimizeButton").disabled = true;
  $("downloadEvaluationButton").disabled = true;
  $("evalRunStatus").textContent = "Memeriksa endpoint lokal dan model...";
  $("evalResultSummary").hidden = true;
  $("evalResultList").replaceChildren();

  try {
    const baseUrl = normalizeOllamaBaseUrl($("ollamaEndpoint").value);
    const model = $("ollamaModel").value.trim();
    const available = await listLocalModels(baseUrl);
    if (!model || !available.includes(model)) {
      throw new Error("Model belum diverifikasi atau tidak lagi tersedia. Klik Cek koneksi & model pada panel engine.");
    }

    for (let index = 0; index < evaluationCases.length; index++) {
      const item = evaluationCases[index];
      $("evalRunStatus").textContent = "Kasus " + (index + 1) + "/" + evaluationCases.length + ": " + item.name + " · menjalankan baseline dan revisi...";
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 240000);
      try {
        let baseline;
        let candidate;
        try {
          const output = await runPromptTaskWithOllama({ baseUrl, model, prompt: originalPrompt, testInput: item.input, signal: controller.signal });
          baseline = scoreEvaluationOutput(output, item);
        } catch (error) {
          throw new Error("Baseline gagal: " + (error?.name === "AbortError" ? "waktu eksekusi habis." : error.message));
        }
        try {
          const output = await runPromptTaskWithOllama({ baseUrl, model, prompt: candidatePrompt, testInput: item.input, signal: controller.signal });
          candidate = scoreEvaluationOutput(output, item);
        } catch (error) {
          throw new Error("Prompt revisi gagal: " + (error?.name === "AbortError" ? "waktu eksekusi habis." : error.message));
        }
        completed.push({ caseId: item.id, caseName: item.name, baseline, candidate });
      } catch (error) {
        completed.push({ caseId: item.id, caseName: item.name, baseline: null, candidate: null, error: error instanceof Error ? error.message : "Evaluasi gagal." });
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    latestEvaluationReport = createEvaluationReport({
      evaluatedAt: new Date().toISOString(),
      model,
      baselinePrompt: originalPrompt,
      candidatePrompt,
      results: completed
    });
    renderEvaluationResults(latestEvaluationReport);
    const succeeded = completed.filter((item) => item.baseline && item.candidate).length;
    $("evalRunStatus").textContent = "Selesai · " + succeeded + "/" + completed.length + " kasus berhasil dibandingkan.";
    showToast("Evaluasi selesai. Periksa regresi dan output model sebelum menyimpulkan revisi lebih baik.");
  } catch (error) {
    $("evalRunStatus").textContent = error instanceof Error ? error.message : "Evaluasi tidak dapat dimulai.";
    showToast(error instanceof Error ? error.message : "Evaluasi tidak dapat dimulai.");
  } finally {
    button.disabled = false;
    $("autoOptimizeButton").disabled = false;
    button.textContent = originalLabel;
  }
}


async function withOptimizationRequestTimeout(parentSignal, request) {
  const requestController = new AbortController();
  const abortFromParent = () => requestController.abort();
  if (parentSignal?.aborted) requestController.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutId = window.setTimeout(() => requestController.abort(), 180000);
  try {
    return await request(requestController.signal);
  } finally {
    window.clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function evaluatePromptAgainstSuite({ prompt, baselinePrompt, baselineResults, cases, baseUrl, model, signal, onProgress }) {
  const baselineById = new Map(baselineResults.map((item) => [item.caseId, item]));
  const results = [];
  for (let index = 0; index < cases.length; index++) {
    if (signal.aborted) throw new DOMException("Optimasi dihentikan.", "AbortError");
    const item = cases[index];
    onProgress?.("Menguji kandidat · " + (index + 1) + "/" + cases.length + ": " + item.name);
    const baselineRecord = baselineById.get(item.id);
    if (!baselineRecord?.baseline) throw new Error("Output baseline tidak tersedia untuk kasus: " + item.name);
    const output = await withOptimizationRequestTimeout(signal, (requestSignal) => runPromptTaskWithOllama({
      baseUrl, model, prompt, testInput: item.input, signal: requestSignal
    }));
    results.push({
      caseId: item.id,
      caseName: item.name,
      baseline: baselineRecord.baseline,
      candidate: scoreEvaluationOutput(output, item)
    });
  }
  return createEvaluationReport({
    evaluatedAt: new Date().toISOString(),
    model,
    baselinePrompt,
    candidatePrompt: prompt,
    results
  });
}

function annotateOptimizationReport(report, maxIterations, attempts, stopReason) {
  return createEvaluationReport({
    evaluatedAt: report.evaluatedAt,
    model: report.model,
    baselinePrompt: report.baselinePrompt,
    candidatePrompt: report.candidatePrompt,
    results: report.results,
    optimization: {
      strategy: "guarded-local-search",
      maxIterations,
      attemptedIterations: Math.max(0, attempts.length - 1),
      acceptedCandidates: attempts.filter((item) => item.iteration > 0 && item.accepted).length,
      stopReason,
      trials: attempts
    }
  });
}

function summarizeTrialReport(report) {
  return {
    baselinePass: report.summary.baselinePass,
    candidatePass: report.summary.candidatePass,
    regressions: report.summary.regressions,
    baselineAverageScore: report.summary.baselineAverageScore,
    candidateAverageScore: report.summary.candidateAverageScore,
    failures: report.results.filter((item) => item.error || (item.candidate?.checks ?? []).some((check) => !check.passed)).map((item) => ({
      caseName: item.caseName,
      error: item.error ?? null,
      failedChecks: (item.candidate?.checks ?? []).filter((check) => !check.passed).map((check) => ({ label: check.label, detail: check.detail }))
    }))
  };
}

function describeCandidateRank(report, prompt) {
  const rank = rankOptimizationCandidate(report, prompt);
  return {
    regressions: rank.regressions,
    passedCases: rank.passedCases,
    totalCases: rank.totalCases,
    averageScore: rank.averageScore,
    wordCount: rank.wordCount
  };
}

async function runAutomaticOptimization() {
  if (activeOptimizationController) return;
  const originalPrompt = currentOriginal();
  if (!originalPrompt) {
    showToast("Isi prompt awal sebelum memulai optimasi otomatis.");
    $("originalPrompt").focus();
    return;
  }
  if (evaluationCases.length === 0) {
    showToast("Tambahkan test case terukur sebelum memulai optimasi otomatis.");
    $("evalCaseName").focus();
    return;
  }

  const settings = readSettings();
  const cases = evaluationCases.map((item) => ({
    ...item,
    requiredText: [...item.requiredText],
    forbiddenText: [...item.forbiddenText],
    requiredKeys: [...item.requiredKeys]
  }));
  const maxIterations = Math.max(1, Math.min(3, Number.parseInt($("autoOptimizationIterations").value, 10) || 2));
  let initialCandidate = $("improvedPrompt").value.trim();
  if (!initialCandidate) {
    try {
      initialCandidate = buildImprovedPrompt({ originalPrompt, ...settings });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Prompt awal tidak dapat disusun.");
      return;
    }
  }

  const controller = new AbortController();
  activeOptimizationController = controller;
  const startButton = $("autoOptimizeButton");
  const stopButton = $("stopOptimizationButton");
  const evalButton = $("runEvaluationButton");
  const improveButton = $("improveButton");
  const iterateButton = $("iterateButton");
  const saveButton = $("saveButton");
  const exportButton = $("downloadEvaluationButton");
  const addCaseButton = $("addEvalCaseButton");
  const resetButton = $("resetButton");
  const caseDeleteButtons = [...$("evalCaseList").querySelectorAll("button[data-eval-action='delete']")];
  startButton.disabled = true;
  evalButton.disabled = true;
  improveButton.disabled = true;
  iterateButton.disabled = true;
  saveButton.disabled = true;
  exportButton.disabled = true;
  addCaseButton.disabled = true;
  resetButton.disabled = true;
  for (const button of caseDeleteButtons) button.disabled = true;
  stopButton.hidden = false;
  stopButton.disabled = false;
  $("evalResultSummary").hidden = true;
  $("evalResultList").replaceChildren();
  $("autoOptimizerStatus").dataset.tone = "neutral";
  $("autoOptimizerStatus").textContent = "Memeriksa Ollama dan menyiapkan baseline...";
  $("evalRunStatus").textContent = "Optimasi otomatis: menyiapkan baseline dan " + cases.length + " test case.";

  let bestPrompt = initialCandidate;
  let bestReport = null;
  let attempts = [];
  let baselineResults = [];
  let stopReason = "iteration_limit";

  try {
    const baseUrl = normalizeOllamaBaseUrl($("ollamaEndpoint").value);
    const model = $("ollamaModel").value.trim();
    const available = await listLocalModels(baseUrl, { signal: controller.signal });
    if (!model || !ollamaModels.includes(model) || !available.includes(model)) {
      throw new Error("Pilih dan verifikasi model Ollama yang terpasang sebelum menjalankan optimasi.");
    }
    saveOllamaConfig();

    baselineResults = [];
    for (let index = 0; index < cases.length; index++) {
      if (controller.signal.aborted) throw new DOMException("Optimasi dihentikan.", "AbortError");
      const item = evaluationCases[index];
      $("autoOptimizerStatus").textContent = "Baseline " + (index + 1) + "/" + cases.length + ": " + item.name;
      $("evalRunStatus").textContent = "Optimasi otomatis · menjalankan baseline " + (index + 1) + "/" + cases.length + ".";
      const output = await withOptimizationRequestTimeout(controller.signal, (requestSignal) => runPromptTaskWithOllama({
        baseUrl, model, prompt: originalPrompt, testInput: item.input, signal: requestSignal
      }));
      baselineResults.push({
        caseId: item.id,
        caseName: item.name,
        baseline: scoreEvaluationOutput(output, item)
      });
    }

    bestReport = await evaluatePromptAgainstSuite({
      prompt: bestPrompt,
      baselinePrompt: originalPrompt,
      baselineResults,
      cases,
      baseUrl,
      model,
      signal: controller.signal,
      onProgress: (message) => { $("evalRunStatus").textContent = "Optimasi otomatis · " + message; }
    });
    const initialRank = describeCandidateRank(bestReport, bestPrompt);
    attempts.push({
      iteration: 0,
      accepted: true,
      reason: "Kandidat awal; digunakan sebagai baseline pencarian.",
      prompt: bestPrompt,
      rank: initialRank,
      evaluation: summarizeTrialReport(bestReport)
    });
    latestEvaluationReport = annotateOptimizationReport(bestReport, maxIterations, attempts, "searching");
    renderEvaluationResults(latestEvaluationReport);
    $("improvedPrompt").value = bestPrompt;
    updateWordCounts();

    if (hasMetOptimizationTarget(bestReport)) {
      stopReason = "all_checks_passed";
    } else {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (controller.signal.aborted) throw new DOMException("Optimasi dihentikan.", "AbortError");
        if (hasMetOptimizationTarget(bestReport)) {
          stopReason = "all_checks_passed";
          break;
        }

        $("autoOptimizerStatus").textContent = "Putaran " + iteration + "/" + maxIterations + ": menyusun kandidat dari kegagalan yang terukur...";
        $("evalRunStatus").textContent = "Optimasi otomatis · meminta revisi kandidat " + iteration + "/" + maxIterations + ".";
        const feedback = buildOptimizationFeedback(bestReport, iteration);
        const promptSettings = {
          ...settings,
          iterationNotes: [...settings.iterationNotes, feedback]
        };
        const proposedPrompt = (await withOptimizationRequestTimeout(controller.signal, (requestSignal) => improvePromptWithOllama({
          baseUrl,
          model,
          originalPrompt,
          structuredDraft: bestPrompt,
          settings: promptSettings,
          signal: requestSignal
        }))).trim();

        if (!proposedPrompt || proposedPrompt === bestPrompt.trim()) {
          attempts.push({
            iteration,
            accepted: false,
            reason: "Model tidak menghasilkan perubahan prompt yang bermakna.",
            prompt: proposedPrompt || "",
            rank: null
          });
          stopReason = "candidate_unchanged";
          break;
        }

        const proposedReport = await evaluatePromptAgainstSuite({
          prompt: proposedPrompt,
          baselinePrompt: originalPrompt,
          baselineResults,
          cases,
          baseUrl,
          model,
          signal: controller.signal,
          onProgress: (message) => {
            $("evalRunStatus").textContent = "Putaran " + iteration + "/" + maxIterations + " · " + message;
          }
        });
        const accepted = isCandidateBetter(proposedReport, proposedPrompt, bestReport, bestPrompt);
        const rank = describeCandidateRank(proposedReport, proposedPrompt);
        const reason = accepted
          ? "Diterima: urutan kualitas meningkat tanpa mengubah kriteria tes."
          : rank.regressions > describeCandidateRank(bestReport, bestPrompt).regressions
            ? "Ditolak: kandidat menambah regresi terhadap baseline."
            : rank.passedCases < describeCandidateRank(bestReport, bestPrompt).passedCases
              ? "Ditolak: jumlah kasus yang lulus menurun."
              : rank.averageScore < describeCandidateRank(bestReport, bestPrompt).averageScore
                ? "Ditolak: skor kriteria terukur menurun."
                : "Ditolak: tidak ada peningkatan terukur yang cukup untuk mengganti kandidat terbaik.";
        attempts.push({ iteration, accepted, reason, prompt: proposedPrompt, rank, evaluation: summarizeTrialReport(proposedReport) });

        if (accepted) {
          bestPrompt = proposedPrompt;
          bestReport = proposedReport;
          $("improvedPrompt").value = bestPrompt;
          updateWordCounts();
          $("autoOptimizerStatus").textContent = "Putaran " + iteration + " diterima. " + rank.passedCases + "/" + rank.totalCases + " kasus lulus; " + rank.regressions + " regresi.";
          latestEvaluationReport = annotateOptimizationReport(bestReport, maxIterations, attempts, "searching");
          renderEvaluationResults(latestEvaluationReport);
        } else {
          $("autoOptimizerStatus").textContent = "Putaran " + iteration + " ditolak. Kandidat terbaik sebelumnya tetap dipertahankan.";
        }

        if (hasMetOptimizationTarget(bestReport)) {
          stopReason = "all_checks_passed";
          break;
        }
      }
    }

    latestEvaluationReport = annotateOptimizationReport(bestReport, maxIterations, attempts, stopReason);
    renderEvaluationResults(latestEvaluationReport);
    $("improvedPrompt").value = bestPrompt;
    updateWordCounts();
    const rank = describeCandidateRank(bestReport, bestPrompt);
    const acceptedCount = attempts.filter((item) => item.iteration > 0 && item.accepted).length;
    const finalStatus = controller.signal.aborted ? "Optimasi dihentikan" : "Optimasi selesai";
    $("evalRunStatus").textContent = finalStatus + " · terbaik " + rank.passedCases + "/" + rank.totalCases + " kasus lulus, " + rank.regressions + " regresi, " + acceptedCount + " kandidat diterima.";
    $("autoOptimizerStatus").dataset.tone = hasMetOptimizationTarget(bestReport) ? "success" : rank.regressions > 0 ? "error" : "neutral";
    $("autoOptimizerStatus").textContent = (controller.signal.aborted ? "Dihentikan manual." : stopReason === "all_checks_passed" ? "Target tercapai; dihentikan lebih awal untuk menghemat waktu dan komputasi." : "Batas iterasi tercapai atau tidak ditemukan kandidat yang lebih baik.") + " Kandidat terbaik dipertahankan dan rincian setiap putaran disimpan pada laporan.";
    showToast("Optimasi selesai. Kandidat terbaik dipertahankan berdasarkan kriteria test suite.");
  } catch (error) {
    const wasStopped = controller.signal.aborted;
    stopReason = wasStopped ? "stopped_by_user" : "error";
    if (bestReport) {
      latestEvaluationReport = annotateOptimizationReport(bestReport, maxIterations, attempts, stopReason);
      renderEvaluationResults(latestEvaluationReport);
      $("improvedPrompt").value = bestPrompt;
      updateWordCounts();
    }
    const message = wasStopped
      ? "Optimasi dihentikan. Kandidat terbaik yang sudah diuji tetap dipertahankan."
      : error?.name === "AbortError"
        ? "Permintaan model lokal melewati batas waktu. Kandidat terbaik yang sudah diuji tetap dipertahankan."
        : error instanceof Error ? error.message : "Optimasi otomatis gagal.";
    $("evalRunStatus").textContent = message;
    $("autoOptimizerStatus").dataset.tone = wasStopped ? "neutral" : "error";
    $("autoOptimizerStatus").textContent = message;
    showToast(message);
  } finally {
    if (activeOptimizationController === controller) activeOptimizationController = null;
    startButton.disabled = false;
    evalButton.disabled = false;
    improveButton.disabled = false;
    iterateButton.disabled = false;
    saveButton.disabled = false;
    addCaseButton.disabled = false;
    resetButton.disabled = false;
    for (const button of $("evalCaseList").querySelectorAll("button[data-eval-action='delete']")) button.disabled = false;
    stopButton.hidden = true;
    stopButton.disabled = true;
    exportButton.disabled = !latestEvaluationReport;
  }
}

function stopAutomaticOptimization() {
  if (!activeOptimizationController) return;
  $("autoOptimizerStatus").textContent = "Menghentikan optimasi setelah permintaan aktif dibatalkan...";
  $("stopOptimizationButton").disabled = true;
  activeOptimizationController.abort();
}


function createCurrentWorkspaceBackup() {
  const workspaceFields = Object.fromEntries(fields.map((id) => [id, $(id).value]));
  workspaceFields.improvedPrompt = $("improvedPrompt").value;
  return createWorkspaceBackup({
    workspace: {
      fields: workspaceFields,
      safeguards: {
        preserveIntent: $("ruleIntent").checked,
        avoidFabrication: $("ruleGrounding").checked,
        review: $("ruleReview").checked
      },
      iterationNotes: [...iterationNotes],
      engine: {
        mode: $("engineMode").value,
        model: $("ollamaModel").value.trim(),
        endpoint: normalizeOllamaBaseUrl($("ollamaEndpoint").value)
      }
    },
    history: savedVersions,
    evaluationCases
  });
}

function exportWorkspaceBackup() {
  try {
    const backup = createCurrentWorkspaceBackup();
    const date = new Date().toISOString().slice(0, 10);
    downloadFile("prompt-improvements-workspace-" + date + ".json", JSON.stringify(backup, null, 2) + "\n", "application/json;charset=utf-8");
    $("workspaceTransferStatus").textContent = "Backup berhasil dibuat. Simpan file di tempat aman; semua data kerja termasuk prompt ada di dalamnya.";
    showToast("Backup workspace berhasil dibuat.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace tidak dapat diekspor.";
    $("workspaceTransferStatus").textContent = "Ekspor gagal: " + message;
    showToast(message);
  }
}

function applyWorkspaceBackup(backup) {
  const storageKeys = [STORAGE_KEY, EVAL_CASES_KEY, OLLAMA_CONFIG_KEY];
  const previous = new Map(storageKeys.map((key) => [key, localStorage.getItem(key)]));
  const next = new Map([
    [STORAGE_KEY, JSON.stringify(backup.history)],
    [EVAL_CASES_KEY, JSON.stringify(backup.evaluationCases)],
    [OLLAMA_CONFIG_KEY, JSON.stringify({ baseUrl: backup.workspace.engine.endpoint, model: backup.workspace.engine.model })]
  ]);
  try {
    for (const [key, value] of next) localStorage.setItem(key, value);
  } catch (error) {
    for (const [key, value] of previous) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Best-effort rollback if the browser has exhausted its storage quota.
      }
    }
    throw new Error("Browser gagal menyimpan backup; perubahan dibatalkan. " + (error instanceof Error ? error.message : ""));
  }

  savedVersions = backup.history;
  evaluationCases = backup.evaluationCases;
  iterationNotes = [...backup.workspace.iterationNotes];
  ollamaConfig = { baseUrl: backup.workspace.engine.endpoint, model: backup.workspace.engine.model };
  ollamaModels = [];
  for (const id of fields) $(id).value = backup.workspace.fields[id] ?? "";
  $("improvedPrompt").value = backup.workspace.fields.improvedPrompt ?? "";
  $("ruleIntent").checked = backup.workspace.safeguards.preserveIntent;
  $("ruleGrounding").checked = backup.workspace.safeguards.avoidFabrication;
  $("ruleReview").checked = backup.workspace.safeguards.review;
  $("iterationFeedback").value = "";
  $("engineMode").value = backup.workspace.engine.mode;
  $("ollamaEndpoint").value = backup.workspace.engine.endpoint;
  const modelSelect = $("ollamaModel");
  if (ollamaConfig.model) {
    let option = [...modelSelect.options].find((item) => item.value === ollamaConfig.model);
    if (!option) {
      option = document.createElement("option");
      option.value = ollamaConfig.model;
      option.textContent = ollamaConfig.model + " (belum diverifikasi)";
      modelSelect.append(option);
    }
    modelSelect.value = ollamaConfig.model;
  } else {
    modelSelect.value = "";
  }

  latestEvaluationReport = null;
  renderHistory();
  renderEvaluationCases();
  $("evalResultSummary").hidden = true;
  $("evalResultList").replaceChildren();
  $("downloadEvaluationButton").disabled = true;
  $("evalRunStatus").textContent = "Workspace dipulihkan. Jalankan evaluasi lagi untuk memeriksa prompt dan test case ini.";
  if (currentOriginal()) {
    lastAnalysis = analyzePrompt(currentOriginal(), readSettings());
    renderAnalysis(lastAnalysis);
  } else {
    lastAnalysis = null;
    $("scoreValue").textContent = "—";
    $("scoreBar").style.width = "0%";
    $("dimensionList").replaceChildren();
  }
  updateWordCounts();
  updateEngineLabel();
  $("resultStatus").textContent = "Workspace dipulihkan";
}

async function importWorkspaceFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 || file.size > MAX_WORKSPACE_FILE_CHARS) {
    throw new Error("File backup melebihi batas 2 MiB.");
  }
  const backup = parseWorkspaceBackup(await file.text());
  const confirmed = window.confirm(
    "Pulihkan backup ini? Data editor, pengaturan, riwayat versi, dan test case saat ini akan diganti.\n\n" +
    backup.history.length + " versi · " + backup.evaluationCases.length + " test case · diekspor " +
    new Date(backup.exportedAt).toLocaleString() + ".\n\nEkspor data saat ini dahulu jika masih diperlukan."
  );
  if (!confirmed) {
    $("workspaceTransferStatus").textContent = "Impor dibatalkan. Workspace saat ini tidak diubah.";
    return;
  }
  applyWorkspaceBackup(backup);
  $("workspaceTransferStatus").textContent = "Backup berhasil dipulihkan · " + backup.history.length + " versi · " + backup.evaluationCases.length + " test case.";
  showToast("Workspace berhasil dipulihkan dari file backup.");
}

function exportEvaluationReport() {
  if (!latestEvaluationReport) {
    showToast("Jalankan evaluasi terlebih dahulu.");
    return;
  }
  const filename = "prompt-evaluation-" + new Date().toISOString().slice(0, 10) + ".json";
  downloadFile(filename, serializeEvaluationReport(latestEvaluationReport), "application/json;charset=utf-8");
  showToast("Laporan evaluasi JSON siap diunduh.");
}

function persistHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedVersions));
    return true;
  } catch {
    showToast("Browser tidak mengizinkan penyimpanan lokal. Salin atau unduh hasil agar tidak hilang.");
    return false;
  }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3100);
}

function currentOriginal() {
  return $("originalPrompt").value.trim();
}

function updateWordCounts() {
  const originalWords = wordCount(currentOriginal());
  $("wordCount").textContent = originalWords + " kata";
  $("inputHint").textContent = originalWords === 0
    ? "Mulai dari instruksi yang sudah kamu punya."
    : originalWords < 8
      ? "Prompt singkat bisa bekerja, tetapi mungkin perlu konteks."
      : "Konteks hanya perlu ditambah jika memang relevan.";
  $("resultWordCount").textContent = wordCount($("improvedPrompt").value) + " kata";
}

function wordCount(value) {
  const text = String(value ?? "").trim();
  return text ? text.split(/\s+/).length : 0;
}

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  $("scoreValue").textContent = analysis.score;
  $("scoreBar").style.width = analysis.score + "%";
  $("scoreSummary").textContent = analysis.score >= 80
    ? "Struktur tampak lengkap menurut sinyal yang diperiksa. Tetap uji hasilnya pada kasus nyata."
    : analysis.score >= 55
      ? "Struktur sudah memiliki beberapa unsur penting. Periksa aspek dengan nilai rendah sebelum memakai prompt."
      : "Masih ada beberapa unsur struktur yang bisa diperjelas. Lengkapi hanya informasi yang benar-benar diketahui.";
  $("resultStatus").textContent = analysis.wordCount ? "Analisis selesai" : "Menunggu input";

  const list = $("dimensionList");
  list.replaceChildren();
  for (const dimension of analysis.dimensions) {
    const card = document.createElement("article");
    card.className = "dimension-card";
    const top = document.createElement("div");
    top.className = "dimension-top";
    const name = document.createElement("span");
    name.className = "dimension-name";
    name.textContent = dimension.label;
    const value = document.createElement("span");
    value.className = "dimension-score";
    value.textContent = dimension.score + "%";
    top.append(name, value);

    const track = document.createElement("div");
    track.className = "dimension-track";
    const fill = document.createElement("div");
    fill.className = "dimension-fill";
    fill.style.width = dimension.score + "%";
    track.append(fill);

    const detail = document.createElement("div");
    detail.className = "dimension-detail";
    detail.textContent = dimension.detail;
    card.append(top, track, detail);
    list.append(card);
  }
}

function analyzeCurrentPrompt() {
  const original = currentOriginal();
  if (!original) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return null;
  }
  const analysis = analyzePrompt(original, readSettings());
  renderAnalysis(analysis);
  return analysis;
}

function buildCurrentPrompt() {
  const original = currentOriginal();
  if (!original) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return null;
  }
  const settings = readSettings();
  const analysis = analyzePrompt(original, settings);
  try {
    const prompt = buildImprovedPrompt({ originalPrompt: original, ...settings });
    $("improvedPrompt").value = prompt;
    renderAnalysis(analysis);
    updateWordCounts();
    $("resultStatus").textContent = "Prompt disusun";
    return prompt;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Prompt tidak dapat disusun.");
    return null;
  }
}

function createVersion() {
  const improvedPrompt = $("improvedPrompt").value.trim();
  const originalPrompt = currentOriginal();
  if (!improvedPrompt || !originalPrompt) {
    showToast("Susun prompt sebelum menyimpan versi.");
    return;
  }
  const settings = readSettings();
  const analysis = lastAnalysis ?? analyzePrompt(originalPrompt, settings);
  const entry = {
    id: makeId(),
    createdAt: new Date().toISOString(),
    originalPrompt,
    settings,
    iterationNotes: [...iterationNotes],
    improvedPrompt,
    analysis
  };
  savedVersions.unshift(entry);
  savedVersions = savedVersions.slice(0, MAX_HISTORY);
  persistHistory();
  renderHistory();
  showToast("Versi disimpan di browser ini.");
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function safeFilename(value) {
  const normalized = String(value || "prompt")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "prompt";
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyPrompt() {
  const value = $("improvedPrompt").value.trim();
  if (!value) {
    showToast("Belum ada hasil untuk disalin.");
    return;
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const area = $("improvedPrompt");
      area.focus();
      area.select();
      const copied = document.execCommand("copy");
      if (!copied) throw new Error("Clipboard unavailable");
    }
    showToast("Prompt disalin ke clipboard.");
  } catch {
    showToast("Clipboard tidak tersedia. Pilih teks hasil lalu salin secara manual.");
  }
}

function exportMarkdown() {
  const value = $("improvedPrompt").value.trim();
  if (!value) {
    showToast("Susun prompt sebelum mengunduh.");
    return;
  }
  downloadFile(safeFilename(currentOriginal()) + ".md", value + "\n", "text/markdown;charset=utf-8");
  showToast("File Markdown siap diunduh.");
}

function exportJson() {
  const improvedPrompt = $("improvedPrompt").value.trim();
  const originalPrompt = currentOriginal();
  if (!improvedPrompt || !originalPrompt) {
    showToast("Susun prompt sebelum mengekspor JSON.");
    return;
  }
  const payload = createExportPayload({
    originalPrompt,
    settings: readSettings(),
    improvedPrompt,
    analysis: lastAnalysis ?? analyzePrompt(originalPrompt, readSettings()),
    iterationNotes
  });
  downloadFile(safeFilename(originalPrompt) + ".json", JSON.stringify(payload, null, 2) + "\n", "application/json;charset=utf-8");
  showToast("Ekspor JSON siap diunduh.");
}

function formatDate(isoDate) {
  try {
    return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

function makeHistoryButton(label, className, action, id, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button " + className;
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = id;
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  return button;
}

function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();
  $("historyCount").textContent = savedVersions.length + (savedVersions.length === 1 ? " versi" : " versi");
  if (savedVersions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "◷";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Belum ada versi tersimpan";
    const description = document.createElement("p");
    description.textContent = "Simpan hasil pertama untuk mulai membandingkan perjalanan perbaikannya.";
    copy.append(title, description);
    empty.append(icon, copy);
    list.append(empty);
    return;
  }

  savedVersions.forEach((version, index) => {
    const card = document.createElement("article");
    card.className = "history-card";
    const top = document.createElement("div");
    top.className = "history-card-top";
    const versionLabel = document.createElement("span");
    versionLabel.className = "history-version";
    versionLabel.textContent = "VERSI " + (savedVersions.length - index).toString().padStart(2, "0");
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = formatDate(version.createdAt);
    top.append(versionLabel, date);

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = version.settings?.objective || version.originalPrompt;
    const preview = document.createElement("div");
    preview.className = "history-preview";
    preview.textContent = version.improvedPrompt.slice(0, 130).replace(/\s+/g, " ") + (version.improvedPrompt.length > 130 ? "…" : "");
    const actions = document.createElement("div");
    actions.className = "history-card-actions";
    actions.append(
      makeHistoryButton("Pulihkan", "button-secondary", "restore", version.id),
      makeHistoryButton("Hapus", "button-quiet delete-version", "delete", version.id, "Hapus versi tersimpan")
    );
    card.append(top, title, preview, actions);
    list.append(card);
  });
}

function restoreVersion(id) {
  const version = savedVersions.find((item) => item.id === id);
  if (!version) return;
  const settings = version.settings ?? {};
  $("originalPrompt").value = version.originalPrompt;
  $("objective").value = settings.objective ?? "";
  $("context").value = settings.context ?? "";
  $("audience").value = settings.audience ?? "";
  $("constraints").value = settings.constraints ?? "";
  $("outputFormat").value = settings.outputFormat ?? "auto";
  $("successCriteria").value = settings.successCriteria ?? "";
  $("ruleIntent").checked = settings.safeguards?.preserveIntent !== false;
  $("ruleGrounding").checked = settings.safeguards?.avoidFabrication !== false;
  $("ruleReview").checked = settings.safeguards?.review !== false;
  iterationNotes = Array.isArray(version.iterationNotes) ? [...version.iterationNotes] : [];
  $("iterationFeedback").value = "";
  $("improvedPrompt").value = version.improvedPrompt;
  renderAnalysis(version.analysis ?? analyzePrompt(version.originalPrompt, settings));
  updateWordCounts();
  $("resultStatus").textContent = "Versi dipulihkan";
  $("originalPrompt").focus();
  showToast("Versi berhasil dipulihkan. Kamu bisa lanjut mengiterasikannya.");
  $("originalPrompt").scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearWorkspace() {
  for (const id of fields) {
    if (id === "outputFormat") $(id).value = "auto";
    else $(id).value = "";
  }
  for (const id of ruleIds) $(id).checked = true;
  $("iterationFeedback").value = "";
  $("improvedPrompt").value = "";
  iterationNotes = [];
  lastAnalysis = null;
  $("scoreValue").textContent = "—";
  $("scoreBar").style.width = "0%";
  $("scoreSummary").textContent = "Masukkan prompt, lalu jalankan analisis untuk melihat aspek yang perlu diperjelas.";
  $("resultStatus").textContent = "Menunggu input";
  $("dimensionList").replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-analysis";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⌁";
  const title = document.createElement("strong");
  title.textContent = "Belum ada analisis";
  const description = document.createElement("span");
  description.textContent = "Enam aspek akan muncul di sini setelah prompt dianalisis.";
  empty.append(icon, title, description);
  $("dimensionList").append(empty);
  updateWordCounts();
  showToast("Workspace baru siap. Riwayat tersimpan tetap aman.");
  $("originalPrompt").focus();
}

$("originalPrompt").addEventListener("input", updateWordCounts);
$("improvedPrompt").addEventListener("input", updateWordCounts);
$("analyzeButton").addEventListener("click", analyzeCurrentPrompt);
$("improveButton").addEventListener("click", runSelectedEngine);
$("checkOllamaButton").addEventListener("click", checkOllamaConnection);
$("addEvalCaseButton").addEventListener("click", addEvaluationCase);
$("runEvaluationButton").addEventListener("click", runEvaluationSuite);
$("exportWorkspaceButton").addEventListener("click", exportWorkspaceBackup);
$("importWorkspaceButton").addEventListener("click", () => $("workspaceImportFile").click());
$("workspaceImportFile").addEventListener("change", async () => {
  const file = $("workspaceImportFile").files?.[0];
  try {
    await importWorkspaceFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : "File backup tidak dapat diimpor.";
    $("workspaceTransferStatus").textContent = "Impor gagal: " + message;
    showToast(message);
  } finally {
    $("workspaceImportFile").value = "";
  }
});
$("autoOptimizeButton").addEventListener("click", runAutomaticOptimization);
$("stopOptimizationButton").addEventListener("click", stopAutomaticOptimization);
$("downloadEvaluationButton").addEventListener("click", exportEvaluationReport);
$("evalCaseList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-eval-action=\"delete\"][data-id]");
  if (!button) return;
  evaluationCases = evaluationCases.filter((item) => item.id !== button.dataset.id);
  persistEvaluationCases();
  renderEvaluationCases();
  showToast("Test case dihapus dari suite lokal.");
});
$("engineMode").addEventListener("change", updateEngineLabel);
$("ollamaModel").addEventListener("change", saveOllamaConfig);
$("ollamaEndpoint").addEventListener("change", () => {
  ollamaModels = [];
  saveOllamaConfig();
  setOllamaStatus("Alamat berubah. Cek koneksi kembali untuk memuat model.");
});
$("iterateButton").addEventListener("click", () => {
  const feedback = $("iterationFeedback").value.trim();
  if (!currentOriginal()) {
    showToast("Isi prompt awal sebelum melakukan iterasi.");
    $("originalPrompt").focus();
    return;
  }
  if (!feedback) {
    showToast("Isi feedback atau perbaikan tambahan untuk iterasi berikutnya.");
    $("iterationFeedback").focus();
    return;
  }
  iterationNotes.push(feedback);
  $("iterationFeedback").value = "";
  runSelectedEngine();
});
$("saveButton").addEventListener("click", createVersion);
$("copyButton").addEventListener("click", copyPrompt);
$("downloadButton").addEventListener("click", exportMarkdown);
$("exportJsonButton").addEventListener("click", exportJson);
$("resetButton").addEventListener("click", clearWorkspace);
$("historyList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action][data-id]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === "restore") restoreVersion(id);
  if (button.dataset.action === "delete") {
    savedVersions = savedVersions.filter((item) => item.id !== id);
    persistHistory();
    renderHistory();
    showToast("Versi dihapus dari browser ini.");
  }
});

updateWordCounts();
renderHistory();
initializeOllamaSettings();
renderEvaluationCases();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // The workbench remains usable if service-worker registration is blocked.
    });
  });
}