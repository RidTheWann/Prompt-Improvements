import { analyzePrompt, buildImprovedPrompt, createExportPayload } from "./prompt-engine.js";
import { PROVIDERS, configureConnection, improvePromptWithAI, listModels, normalizeEndpoint, runPromptTask, researchWebWithOpenRouter } from "./llm-client.js";
import { generateLocalAssistantReply, prepareLocalModel, isLocalModelReady, LOCAL_MODEL, supportsLocalInference } from "./local-ai.js";
import { searchWikipedia, shouldSearchWeb } from "./web-search.js";
import { normalizeEvaluationCase, scoreEvaluationOutput, summarizeEvaluationRun, createEvaluationReport, serializeEvaluationReport } from "./evaluation.js";
import { rankOptimizationCandidate, isCandidateBetter, hasMetOptimizationTarget, buildOptimizationFeedback } from "./optimizer.js";
import { PROMPT_TEMPLATES, getTemplate } from "./templates.js";
import { createWorkspaceBackup, parseWorkspaceBackup, MAX_WORKSPACE_FILE_CHARS } from "./workspace.js";

const STORAGE_KEY = "prompt-improvements.history.v1";
const LLM_CONFIG_KEY = "prompt-improvements.llm.v1";
const REASONING_PREFS_KEY = "prompt-improvements.reasoning.v1";
const KEY_SESSION = "prompt-improvements.api-key.session";
const KEY_PERSIST = "prompt-improvements.api-key.persist";
const EVAL_CASES_KEY = "prompt-improvements.eval-cases.v1";
const MAX_EVAL_CASES = 20;
const MAX_HISTORY = 50;
const ADVANCED_KEY = "prompt-improvements.advanced.v1";
const $ = (id) => document.getElementById(id);

let savedVersions = loadHistory();
let lastAnalysis = null;
let iterationNotes = [];
let toastTimer = null;
let llmConfig = loadLlmConfig();
let reasoningPrefs = loadReasoningPrefs();
let llmModels = [];
let activePromptText = "";
let activeWebSources = [];
let evaluationCases = loadEvaluationCases();
let latestEvaluationReport = null;
let activeOptimizationController = null;
let activeAiController = null;
let activeAiOperationId = 0;
let activeAiInvalidationNotified = false;
let activeGeneration = false;
let localConversation = [];

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



function clearLegacyApiKeys() {
  try { sessionStorage.removeItem(KEY_SESSION); } catch { /* Storage may be disabled. */ }
  try { localStorage.removeItem(KEY_PERSIST); } catch { /* Storage may be disabled. */ }
}

function loadLlmConfig() {
  const fallback = { provider: "openrouter", baseUrl: "", model: "" };
  clearLegacyApiKeys();
  try {
    const stored = JSON.parse(localStorage.getItem(LLM_CONFIG_KEY) || "{}");
    const clean = {
      provider: PROVIDERS[stored.provider] ? stored.provider : fallback.provider,
      baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : "",
      model: typeof stored.model === "string" ? stored.model : ""
    };
    // Migrate old settings and make sure no legacy "remember key" flag remains.
    try { localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(clean)); } catch { /* Optional setting only. */ }
    return clean;
  } catch {
    return fallback;
  }
}

function readStoredKey() {
  clearLegacyApiKeys();
  return "";
}

function loadReasoningPrefs() {
  const defaults = { effort: "medium", webSearch: true };
  try {
    const stored = JSON.parse(localStorage.getItem(REASONING_PREFS_KEY) || "{}");
    const validEfforts = ["auto", "minimal", "low", "medium", "high", "xhigh"];
    return {
      effort: validEfforts.includes(stored.effort) ? stored.effort : defaults.effort,
      webSearch: typeof stored.webSearch === "boolean" ? stored.webSearch : defaults.webSearch
    };
  } catch {
    return defaults;
  }
}

function saveReasoningPrefs() {
  reasoningPrefs = { effort: $("reasoningEffort").value, webSearch: $("webSearchEnabled").checked };
  try { localStorage.setItem(REASONING_PREFS_KEY, JSON.stringify(reasoningPrefs)); } catch { /* Optional setting. */ }
}

function endpointValue() {
  configureConnection({ provider: $("llmProvider").value, apiKey: $("llmApiKey").value });
  return normalizeEndpoint($("llmEndpoint").value);
}

function saveLlmConfig() {
  llmConfig = {
    provider: $("llmProvider").value,
    baseUrl: $("llmEndpoint").value.trim(),
    model: $("llmModel").value.trim()
  };
  const key = $("llmApiKey").value.trim();
  // The provider key remains in the active page/module memory only. Remove
  // credentials saved by older versions and never write a key to web storage.
  clearLegacyApiKeys();
  configureConnection({ provider: llmConfig.provider, apiKey: key });
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(llmConfig));
  } catch {
    showToast("Preferensi tidak dapat disimpan oleh browser. Kamu tetap bisa memakai sesi ini.");
  }
}


function setLlmStatus(message, tone = "neutral") {
  const status = $("llmStatus");
  status.textContent = message;
  status.dataset.tone = tone;
}

function populateLlmModels(models, preferredModel = "") {
  const select = $("llmModel");
  select.replaceChildren();
  llmModels = [...models];
  if (models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Tidak ada model tersedia";
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
  llmConfig.model = select.value;
}

function initializeLlmSettings() {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = provider.label;
    $("llmProvider").append(option);
  }
  $("llmProvider").value = llmConfig.provider;
  $("llmEndpoint").value = llmConfig.baseUrl;
  $("llmApiKey").value = readStoredKey();
  if (llmConfig.model) {
    const option = document.createElement("option");
    option.value = llmConfig.model;
    option.textContent = llmConfig.model + " (belum diverifikasi)";
    $("llmModel").append(option);
    $("llmModel").value = llmConfig.model;
  }
  $("reasoningEffort").value = reasoningPrefs.effort;
  $("webSearchEnabled").checked = reasoningPrefs.webSearch;
  updateProviderFields();
  updateEngineLabel();
}

function updateProviderFields() {
  $("llmEndpointField").hidden = $("llmProvider").value !== "custom";
  updateReasoningControls();
}

function updateReasoningControls() {
  const mode = $("engineMode").value;
  const openRouter = $("llmProvider").value === "openrouter";
  const externalAi = mode === "ai";
  const localAi = mode === "local-ai";
  $("reasoningEffort").disabled = !(externalAi && openRouter);
  $("webSearchEnabled").disabled = !(localAi || (externalAi && openRouter));
  $("reasoningHelp").textContent = localAi
    ? "Inferensi utama berjalan di perangkat tanpa API key. Dengan pencarian aktif, RidTheWann Core memakai web search OpenRouter jika key dan model tersedia; jika tidak, ia mencari Wikipedia. Pencarian OpenRouter bisa menggunakan kredit."
    : openRouter && externalAi
      ? "Reasoning internal tidak ditampilkan. Web search OpenRouter hanya dipakai bila relevan dan dapat menambah biaya selain token model."
      : "Reasoning API dan web search penuh memerlukan OpenRouter. Mode lokal tetap bisa menjawab tanpa key dan memakai Wikipedia saat pencarian relevan.";
}

function updateEngineLabel() {
  const mode = $("engineMode").value;
  const useAi = mode === "ai";
  const useLocal = mode === "local-ai";
  const openRouter = $("llmProvider").value === "openrouter";
  const webEnabled = $("webSearchEnabled").checked;
  $("improveButtonText").textContent = useLocal ? "Kirim ke RidTheWann Core" : useAi ? "Sempurnakan dengan AI" : "Buat prompt yang lebih baik";
  $("localModelPanel").hidden = !useLocal;
  $("analysisDetails").hidden = useLocal;
  $("iterationDetails").hidden = useLocal;
  $("resultHeadingTitle").textContent = useLocal ? "Jawaban dari RidTheWann Core" : "Prompt yang sudah dirapikan";
  $("resultHeadingDescription").textContent = useLocal
    ? "Jawaban dibuat oleh model lokal dan dapat disalin atau diedit."
    : "Salin langsung atau edit sebelum dipakai.";
  $("copyButtonText").textContent = useLocal ? "Salin jawaban" : "Salin prompt";
  const editing = !$("improvedPrompt").hidden;
  $("editPromptButton").textContent = editing ? "Selesai mengedit" : useLocal ? "Edit jawaban" : "Edit prompt";
  $("privacyModeNote").textContent = useLocal
    ? "RidTheWann Core menjawab langsung dengan model open-weight yang berjalan di browser. Inferensi tidak memakai API key. Model diunduh dari internet pada penggunaan pertama dan diproses di perangkat. Pencarian web opsional dapat mengirim kueri ke Wikipedia atau OpenRouter."
    : useAi
      ? "Mode API mengirim isi prompt dan konteks ke penyedia yang dipilih. API key hanya berada di memori halaman. " + (webEnabled && openRouter ? "Pencarian web aktif; penggunaan search dapat menambah biaya OpenRouter." : "Penyempurnaan dilakukan tanpa web search.")
      : "Mode struktur gratis menyusun prompt dengan aturan lokal dan tidak mengirim isi prompt ke layanan luar.";
  updateReasoningControls();
  if (useLocal) {
    if (isLocalModelReady()) setLlmStatus("RidTheWann Core siap · " + LOCAL_MODEL.label, "success");
    else if (!supportsLocalInference()) setLlmStatus("Model lokal memerlukan browser dengan dukungan WebGPU.");
    else setLlmStatus("Model lokal siap diunduh saat pertama digunakan · tanpa API key.");
  } else if (!useAi) {
    setLlmStatus("Mode struktur lokal aktif · tidak membutuhkan API key.");
  } else if (llmModels.length > 0) {
    setLlmStatus(llmModels.length + " model API tersedia.", "success");
  } else {
    setLlmStatus("Masukkan API key opsional lalu cek koneksi untuk memakai AI API atau web search penuh.");
  }
}

async function checkLlmConnection() {
  const button = $("checkLlmButton");
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Memeriksa...";
  setLlmStatus("Menghubungi penyedia AI...");
  try {
    const models = await listModels(endpointValue());
    llmConfig.baseUrl = $("llmEndpoint").value.trim();
    populateLlmModels(models, llmConfig.model);
    saveLlmConfig();
    if (models.length === 0) {
      setLlmStatus("Terhubung, tetapi tidak ada model yang tersedia untuk key ini.", "error");
      return;
    }
    setLlmStatus("Terhubung · " + models.length + " model tersedia.", "success");
    showToast("Koneksi berhasil. Pilih model untuk penyempurnaan AI.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Koneksi gagal.";
    setLlmStatus(message, "error");
    showToast(message);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

function invalidateActiveAiOperation(reason, notify = false) {
  if (!activeAiController) return;
  const controller = activeAiController;
  activeAiOperationId += 1;
  if (!controller.signal.aborted) {
    const abortError = new Error(reason);
    abortError.name = "AbortError";
    controller.abort(abortError);
  }
  if (notify && !activeAiInvalidationNotified) {
    activeAiInvalidationNotified = true;
    const message = "Respons AI dihentikan karena " + reason + ".";
    $("resultStatus").textContent = "AI dibatalkan · " + reason;
    setLlmStatus(message, "neutral");
    if (!$("assistantThinking").hidden) {
      $("assistantThinking").classList.add("is-cancelled");
      $("thinkingMessage").textContent = message;
    }
    showToast(message);
  } else if (!notify) {
    activeAiInvalidationNotified = true;
  }
}

function cancelAiImprovement() {
  if (activeAiController) {
    const error = new Error("Pembuatan prompt dengan AI dibatalkan.");
    error.name = "AbortError";
    activeAiController.abort(error);
  }
}

function mergeWebSources(...groups) {
  const seen = new Set();
  const merged = [];
  for (const source of groups.flat()) {
    if (!source || typeof source.url !== "string") continue;
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    merged.push({
      title: String(source.title || source.domain || url.hostname).slice(0, 240),
      domain: String(source.domain || url.hostname).slice(0, 120),
      snippet: String(source.snippet || "").slice(0, 1400),
      url: url.href
    });
    if (merged.length >= 10) return merged;
  }
  return merged;
}

function localModelProgress(report) {
  const status = $("localModelStatus");
  const message = typeof report?.text === "string" && report.text.trim()
    ? report.text.trim()
    : "Menyiapkan model lokal...";
  const percent = Number(report?.progress);
  status.textContent = Number.isFinite(percent) && percent >= 0 && percent <= 1
    ? message.slice(0, 180) + " (" + Math.round(percent * 100) + "%)"
    : message.slice(0, 220);
}

async function loadLocalModelFromSettings() {
  const button = $("loadLocalModelButton");
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Menyiapkan...";
  $("localModelStatus").textContent = "Memulai runtime lokal. Unduhan pertama dapat membutuhkan waktu.";
  try {
    await prepareLocalModel({ onProgress: localModelProgress });
    $("localModelStatus").textContent = "Model siap. Inferensi berikutnya berlangsung di browser ini.";
    setLlmStatus("RidTheWann Core siap digunakan tanpa API key.", "success");
    showToast("Model lokal siap digunakan.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model lokal gagal dimuat.";
    $("localModelStatus").textContent = message;
    setLlmStatus(message, "error");
    showToast(message);
  } finally {
    button.textContent = isLocalModelReady() ? "Model siap" : previous;
    button.disabled = isLocalModelReady();
  }
}

function renderLocalConversationArchive() {
  const container = $("conversationArchive");
  if (!container) return;
  container.replaceChildren();
  for (let index = 0; index < localConversation.length; index += 2) {
    const userMessage = localConversation[index];
    const assistantMessage = localConversation[index + 1];
    if (userMessage?.role !== "user" || assistantMessage?.role !== "assistant") continue;
    const turn = document.createElement("article");
    turn.className = "conversation-archive-turn";
    const user = document.createElement("div");
    user.className = "conversation-archive-user";
    const userLabel = document.createElement("strong");
    userLabel.textContent = "Kamu";
    const userText = document.createElement("p");
    userText.textContent = userMessage.content;
    user.append(userLabel, userText);
    const assistant = document.createElement("div");
    assistant.className = "conversation-archive-assistant";
    const assistantLabel = document.createElement("strong");
    assistantLabel.textContent = "RidTheWann Core";
    const assistantText = document.createElement("p");
    assistantText.textContent = assistantMessage.content;
    assistant.append(assistantLabel, assistantText);
    turn.append(user, assistant);
    container.append(turn);
  }
  container.hidden = container.childElementCount === 0;
}

async function runLocalAssistantTurn(originalPrompt, settings) {
  const button = $("improveButton");
  const cancelButton = $("cancelImproveButton");
  const controller = new AbortController();
  const operationId = ++activeAiOperationId;
  let timeoutId;
  let streamedOutput = "";
  let sources = [];
  let researchSummary = "";
  let searchNote = "";
  activeGeneration = true;
  activeAiController = controller;
  activeAiInvalidationNotified = false;
  button.disabled = true;
  cancelButton.hidden = false;
  cancelButton.disabled = false;
  renderLocalConversationArchive();
  const webSearchEnabled = $("webSearchEnabled").checked;
  const shouldSearch = webSearchEnabled && shouldSearchWeb(originalPrompt);
  beginAssistantTurn(originalPrompt, shouldSearch
    ? "RidTheWann Core sedang mencari konteks web dan menyiapkan model lokal..."
    : "RidTheWann Core sedang menyiapkan model lokal...");
  $("improveButtonText").textContent = "RidTheWann Core bekerja...";
  $("resultStatus").textContent = "Model lokal sedang diproses";
  $("localModelStatus").textContent = isLocalModelReady()
    ? "Model telah dimuat; menyiapkan jawaban."
    : "Runtime dan bobot model sedang dimuat. Unduhan pertama memerlukan koneksi internet.";
  timeoutId = window.setTimeout(() => {
    if (activeAiController === controller && !controller.signal.aborted) {
      const timeoutError = new Error("Model lokal melewati batas waktu 12 menit. Periksa koneksi saat unduhan pertama atau coba ulang.");
      timeoutError.name = "TimeoutError";
      controller.abort(timeoutError);
    }
  }, 720000);

  try {
    if (shouldSearch) {
      $("thinkingMessage").textContent = "Mencari sumber web yang relevan...";
      let externalSearchSources = [];
      if ($("llmProvider").value === "openrouter" && $("llmApiKey").value.trim() &&
          $("llmModel").value.trim() && llmModels.includes($("llmModel").value.trim())) {
        try {
          const research = await researchWebWithOpenRouter({
            baseUrl: endpointValue(),
            model: $("llmModel").value.trim(),
            query: originalPrompt,
            reasoningEffort: $("reasoningEffort").value,
            signal: controller.signal,
            onSources: (items) => {
              if (operationId !== activeAiOperationId || controller.signal.aborted) return;
              externalSearchSources = mergeWebSources(externalSearchSources, items);
              activeWebSources = mergeWebSources(externalSearchSources, sources);
              renderWebSources(activeWebSources);
              $("thinkingMessage").textContent = "Sumber web umum ditemukan. Menyiapkan jawaban lokal...";
            }
          });
          researchSummary = research.text;
          externalSearchSources = mergeWebSources(externalSearchSources, research.sources);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          setLlmStatus("Pencarian web OpenRouter gagal; mencoba Wikipedia sebagai alternatif.", "neutral");
        }
      }
      try {
        const wikiSources = await searchWikipedia(originalPrompt, { signal: controller.signal });
        sources = mergeWebSources(externalSearchSources, wikiSources);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        sources = mergeWebSources(externalSearchSources);
      }
      if (operationId !== activeAiOperationId) return;
      activeWebSources = sources;
      renderWebSources(sources);
      if (!sources.length && !researchSummary) {
        searchNote = "Pencarian web tidak menghasilkan sumber yang dapat dipakai; fakta terbaru tidak dianggap telah diverifikasi.";
      }
    }

    const answer = await generateLocalAssistantReply({
      prompt: originalPrompt,
      settings,
      history: localConversation.slice(-6),
      sources,
      researchSummary,
      searchAttempted: shouldSearch,
      signal: controller.signal,
      onProgress: localModelProgress,
      onChunk: (partial) => {
        if (operationId !== activeAiOperationId || controller.signal.aborted) return;
        streamedOutput = partial;
        $("thinkingMessage").textContent = "RidTheWann Core sedang menyusun jawaban...";
      }
    });
    if (operationId !== activeAiOperationId) return;
    $("improvedPrompt").value = answer;
    localConversation.push({ role: "user", content: originalPrompt }, { role: "assistant", content: answer });
    localConversation = localConversation.slice(-12);
    renderLocalConversationArchive();
    $("assistantReplyIntro").textContent = sources.length
      ? "Dijawab oleh RidTheWann Core dengan model lokal. Sumber web tersedia di bawah; periksa sumber untuk klaim penting."
      : searchNote
        ? "Jawaban model lokal tanpa sumber web terverifikasi. " + searchNote
        : "Dijawab langsung oleh RidTheWann Core di browser; inferensi tidak memerlukan API key.";
    $("resultStatus").textContent = "RidTheWann Core selesai";
    $("localModelStatus").textContent = "Model siap. Jawaban diproses secara lokal.";
    updateWordCounts();
    revealOutputPanel();
    setLlmStatus(sources.length
      ? "Jawaban lokal selesai · " + sources.length + " sumber web tersedia."
      : "Jawaban lokal selesai · " + (shouldSearch ? "pencarian tidak menghasilkan sumber yang dapat dipakai." : "tidak menggunakan pencarian web."),
      "success");
    showToast("RidTheWann Core selesai menjawab.");
  } catch (error) {
    if (operationId !== activeAiOperationId) return;
    const isTimeout = error?.name === "TimeoutError" || controller.signal.reason?.name === "TimeoutError";
    const isAbort = (error?.name === "AbortError" || controller.signal.aborted) && !isTimeout;
    const message = isTimeout
      ? "Waktu pemrosesan model lokal habis. Coba lagi setelah model selesai diunduh."
      : error instanceof Error ? error.message : "RidTheWann Core gagal menghasilkan jawaban.";
    const text = isAbort
      ? streamedOutput.trim() || "Pembuatan jawaban dibatalkan. Jika model sudah diunduh, jawaban parsial dapat dicoba ulang."
      : "RidTheWann Core belum dapat menjawab.\n\n" + message + "\n\nCoba siapkan model lokal, gunakan Struktur lokal untuk menyusun prompt, atau pilih AI via API key.";
    $("improvedPrompt").value = text;
    $("assistantReplyIntro").textContent = isAbort ? "Proses lokal dibatalkan." : "Model lokal tidak berhasil dijalankan.";
    $("resultStatus").textContent = isAbort ? "Dibatalkan" : "Model lokal gagal";
    $("localModelStatus").textContent = message;
    updateWordCounts();
    revealOutputPanel();
    setLlmStatus(message, isAbort ? "neutral" : "error");
    showToast(message);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (activeAiController === controller) activeAiController = null;
    activeGeneration = false;
    button.disabled = false;
    cancelButton.hidden = true;
    cancelButton.disabled = true;
    updateEngineLabel();
  }
}

async function runSelectedEngine({ reuseActivePrompt = false } = {}) {
  if (activeGeneration || activeAiController) return;

  const originalPrompt = $("originalPrompt").value.trim() || (reuseActivePrompt ? activePromptText : "");
  if (!originalPrompt) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return;
  }
  const settings = readSettings();
  if ($("engineMode").value === "local-ai") {
    await runLocalAssistantTurn(originalPrompt, settings);
    return;
  }
  let deterministicDraft;
  try { deterministicDraft = buildImprovedPrompt({ originalPrompt, ...settings }); }
  catch (error) {
    showToast(error instanceof Error ? error.message : "Prompt tidak dapat disusun.");
    return;
  }

  const previousOutput = $("improvedPrompt").value.trim();
  const draftToImprove = iterationNotes.length > 0 && previousOutput ? previousOutput : deterministicDraft;
  const button = $("improveButton");
  const cancelButton = $("cancelImproveButton");
  const previousButtonLabel = $("improveButtonText").textContent;
  activeGeneration = true;
  button.disabled = true;

  if ($("engineMode").value !== "ai") {
    beginAssistantTurn(originalPrompt, "Mesin sedang menghasilkan prompt...");
    $("improveButtonText").textContent = "Menyusun...";
    try {
      // Give the browser one paint so the chat-native progress state is visible
      // even though deterministic prompt structuring is usually very fast.
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      $("improvedPrompt").value = deterministicDraft;
      const analysis = analyzePrompt(originalPrompt, { ...settings, improvedPrompt: deterministicDraft });
      renderAnalysis(analysis);
      updateWordCounts();
      $("resultStatus").textContent = iterationNotes.length ? "Iterasi " + iterationNotes.length : "Prompt disusun";
      revealOutputPanel();
      showToast(iterationNotes.length
        ? "Iterasi struktur diperbarui. Prompt awal dan seluruh catatan tetap dipertahankan."
        : "Prompt berhasil dibuat. Tinjau sebentar, lalu salin ke AI pilihanmu.");
    } catch (error) {
      $("improvedPrompt").value = deterministicDraft;
      updateWordCounts();
      $("resultStatus").textContent = "Draf struktur tersedia";
      revealOutputPanel();
      showToast(error instanceof Error ? error.message : "Prompt berhasil disusun dalam mode struktur.");
    } finally {
      button.disabled = false;
      $("improveButtonText").textContent = previousButtonLabel;
      activeGeneration = false;
    }
    return;
  }

  const useOpenRouterTools = $("llmProvider").value === "openrouter";
  const reasoningEffort = useOpenRouterTools ? $("reasoningEffort").value : "auto";
  const webSearch = useOpenRouterTools && $("webSearchEnabled").checked;
  beginAssistantTurn(originalPrompt, webSearch
    ? "Menganalisis permintaan dan mencari sumber web bila diperlukan..."
    : "Menganalisis instruksi dan menyusun prompt...");
  cancelButton.hidden = false;
  cancelButton.disabled = false;
  $("improveButtonText").textContent = "AI sedang bekerja...";
  $("resultStatus").textContent = "Mengirim prompt ke model...";
  setLlmStatus("Mengirim prompt ke penyedia AI yang dipilih. Waktu respons bergantung pada model dan koneksi.");

  let timeoutId;
  let streamedOutput = "";
  let controller = null;
  let operationId = null;
  try {
    const baseUrl = endpointValue();
    const model = $("llmModel").value.trim();
    if (!model || !llmModels.includes(model)) {
      throw new Error("Cek koneksi dan pilih model yang terpasang sebelum memakai AI.");
    }
    saveLlmConfig();
    controller = new AbortController();
    activeAiController = controller;
    activeAiInvalidationNotified = false;
    operationId = ++activeAiOperationId;
    timeoutId = window.setTimeout(() => {
      if (activeAiController === controller && !controller.signal.aborted) {
        const timeoutErr = new Error("Permintaan dihentikan setelah 4 menit. Coba model yang lebih kecil atau prompt yang lebih ringkas.");
        timeoutErr.name = "TimeoutError";
        controller.abort(timeoutErr);
      }
    }, 240000);

    const refinedPrompt = await improvePromptWithAI({
      baseUrl,
      model,
      originalPrompt,
      structuredDraft: draftToImprove,
      settings,
      reasoningEffort,
      webSearch,
      signal: controller.signal,
      onSources: (sources) => {
        if (operationId !== activeAiOperationId || controller.signal.aborted) return;
        const seen = new Set();
        activeWebSources = [...activeWebSources, ...sources].filter((source) => {
          if (!source?.url || seen.has(source.url)) return false;
          seen.add(source.url);
          return true;
        }).slice(0, 10);
        renderWebSources(activeWebSources);
        $("thinkingMessage").textContent = "Sumber web ditemukan. Memeriksa relevansi dan merapikan prompt...";
      },
      onChunk: (_chunk, accumulated) => {
        if (operationId !== activeAiOperationId || controller.signal.aborted) return;
        // Keep the final prompt hidden until the model finishes. Retain partial
        // output only as a recovery draft if the request fails or is cancelled.
        streamedOutput = accumulated;
        $("thinkingMessage").textContent = "AI sedang menghasilkan dan merapikan prompt...";
        $("resultStatus").textContent = "AI sedang menghasilkan...";
      }
    });
    if (operationId !== activeAiOperationId) return;
    $("improvedPrompt").value = refinedPrompt;
    $("resultStatus").textContent = iterationNotes.length ? "Iterasi AI " + iterationNotes.length : "AI selesai";
    const analysis = analyzePrompt(originalPrompt, { ...settings, improvedPrompt: refinedPrompt });
    renderAnalysis(analysis);
    updateWordCounts();
    setLlmStatus("Selesai · prompt diproses oleh penyedia AI yang dipilih.", "success");
    revealOutputPanel();
    showToast("Prompt disempurnakan dengan AI. Periksa hasilnya sebelum digunakan.");
  } catch (error) {
    if (operationId !== null && operationId !== activeAiOperationId) return;
    const isTimeout = error?.name === "TimeoutError" || controller?.signal?.reason?.name === "TimeoutError";
    const isAbort = (error?.name === "AbortError" || controller?.signal?.aborted) && !isTimeout;
    const message = isTimeout
      ? "Permintaan dihentikan setelah 4 menit. Coba model yang lebih kecil atau prompt yang lebih ringkas."
      : error instanceof Error ? error.message : "AI gagal menyempurnakan prompt.";

    if (isAbort) {
      $("resultStatus").textContent = "AI dibatalkan · draf tersedia";
      setLlmStatus("Pembuatan prompt dengan AI dibatalkan; draf struktur tetap tersedia.", "neutral");
      showToast("AI dibatalkan. Draf struktur tetap tersedia untuk disalin.");
    } else {
      $("resultStatus").textContent = isTimeout ? "Waktu AI habis · draf tersedia" : "AI gagal · draf tersedia";
      setLlmStatus(message, "error");
      showToast(message + " Draf struktur tetap tersedia.");
    }

    // A complete or partial local/model draft remains available instead of a blank panel.
    $("improvedPrompt").value = streamedOutput.trim() || draftToImprove;
    const analysis = analyzePrompt(originalPrompt, { ...settings, improvedPrompt: $("improvedPrompt").value });
    renderAnalysis(analysis);
    updateWordCounts();
    revealOutputPanel();
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (activeAiController === controller) activeAiController = null;
    activeGeneration = false;
    button.disabled = false;
    $("improveButtonText").textContent = previousButtonLabel;
    cancelButton.hidden = true;
    cancelButton.disabled = true;
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
  $("evalRunStatus").textContent = "Memeriksa koneksi dan model...";
  $("evalResultSummary").hidden = true;
  $("evalResultList").replaceChildren();

  try {
    const baseUrl = endpointValue();
    const model = $("llmModel").value.trim();
    const available = await listModels(baseUrl);
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
          const output = await runPromptTask({ baseUrl, model, prompt: originalPrompt, testInput: item.input, signal: controller.signal });
          baseline = scoreEvaluationOutput(output, item);
        } catch (error) {
          throw new Error("Baseline gagal: " + (error?.name === "AbortError" ? "waktu eksekusi habis." : error.message));
        }
        try {
          const output = await runPromptTask({ baseUrl, model, prompt: candidatePrompt, testInput: item.input, signal: controller.signal });
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
    const output = await withOptimizationRequestTimeout(signal, (requestSignal) => runPromptTask({
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
  $("autoOptimizerStatus").textContent = "Memeriksa penyedia AI dan menyiapkan baseline...";
  $("evalRunStatus").textContent = "Optimasi otomatis: menyiapkan baseline dan " + cases.length + " test case.";

  let bestPrompt = initialCandidate;
  let bestReport = null;
  let attempts = [];
  let baselineResults = [];
  let stopReason = "iteration_limit";

  try {
    const baseUrl = endpointValue();
    const model = $("llmModel").value.trim();
    const available = await listModels(baseUrl, { signal: controller.signal });
    if (!model || !llmModels.includes(model) || !available.includes(model)) {
      throw new Error("Pilih dan verifikasi model penyedia AI yang terpasang sebelum menjalankan optimasi.");
    }
    saveLlmConfig();

    baselineResults = [];
    for (let index = 0; index < cases.length; index++) {
      if (controller.signal.aborted) throw new DOMException("Optimasi dihentikan.", "AbortError");
      const item = evaluationCases[index];
      $("autoOptimizerStatus").textContent = "Baseline " + (index + 1) + "/" + cases.length + ": " + item.name;
      $("evalRunStatus").textContent = "Optimasi otomatis · menjalankan baseline " + (index + 1) + "/" + cases.length + ".";
      const output = await withOptimizationRequestTimeout(controller.signal, (requestSignal) => runPromptTask({
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
        const proposedPrompt = (await withOptimizationRequestTimeout(controller.signal, (requestSignal) => improvePromptWithAI({
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
        ? "Permintaan model melewati batas waktu. Kandidat terbaik yang sudah diuji tetap dipertahankan."
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
        model: $("llmModel").value.trim(),
        provider: $("llmProvider").value,
        endpoint: $("llmProvider").value === "custom" ? $("llmEndpoint").value.trim() : ""
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
  const storageKeys = [STORAGE_KEY, EVAL_CASES_KEY, LLM_CONFIG_KEY];
  const previous = new Map(storageKeys.map((key) => [key, localStorage.getItem(key)]));
  const next = new Map([
    [STORAGE_KEY, JSON.stringify(backup.history)],
    [EVAL_CASES_KEY, JSON.stringify(backup.evaluationCases)],
    [LLM_CONFIG_KEY, JSON.stringify({ provider: backup.workspace.engine.provider, baseUrl: backup.workspace.engine.endpoint, model: backup.workspace.engine.model })]
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
  llmConfig = { provider: backup.workspace.engine.provider, baseUrl: backup.workspace.engine.endpoint, model: backup.workspace.engine.model };
  llmModels = [];
  for (const id of fields) $(id).value = backup.workspace.fields[id] ?? "";
  $("improvedPrompt").value = backup.workspace.fields.improvedPrompt ?? "";
  $("ruleIntent").checked = backup.workspace.safeguards.preserveIntent;
  $("ruleGrounding").checked = backup.workspace.safeguards.avoidFabrication;
  $("ruleReview").checked = backup.workspace.safeguards.review;
  $("iterationFeedback").value = "";
  $("engineMode").value = backup.workspace.engine.mode;
  $("llmProvider").value = backup.workspace.engine.provider;
  $("llmEndpoint").value = backup.workspace.engine.endpoint;
  updateProviderFields();
  const modelSelect = $("llmModel");
  if (llmConfig.model) {
    let option = [...modelSelect.options].find((item) => item.value === llmConfig.model);
    if (!option) {
      option = document.createElement("option");
      option.value = llmConfig.model;
      option.textContent = llmConfig.model + " (belum diverifikasi)";
      modelSelect.append(option);
    }
    modelSelect.value = llmConfig.model;
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
    lastAnalysis = analyzePrompt(currentOriginal(), { ...readSettings(), improvedPrompt: $("improvedPrompt").value });
    renderAnalysis(lastAnalysis);
  } else {
    lastAnalysis = null;
    $("scoreBeforeValue").textContent = "—";
    $("scoreValue").textContent = "—";
    $("scoreBar").style.width = "0%";
    $("dimensionList").replaceChildren();
  }
  updateWordCounts();
  updateEngineLabel();
  activePromptText = "";
  activeWebSources = [];
  renderWebSources([]);
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

function beginAssistantTurn(originalPrompt, message) {
  activePromptText = originalPrompt;
  activeWebSources = [];
  renderWebSources([]);
  $("assistantThinking").classList.remove("is-cancelled");
  const bubble = $("chatUserBubble");
  const bubbleText = $("chatUserPromptText");
  if (bubble && bubbleText) {
    bubbleText.textContent = originalPrompt;
    bubble.hidden = false;
  }
  $("chatWelcome").classList.add("has-conversation");
  $("outputPanel").hidden = true;
  $("outputPanel").classList.remove("has-result");
  $("improvedPrompt").value = "";
  $("improvedPrompt").hidden = true;
  $("promptPreview").hidden = false;
  $("editPromptButton").textContent = $("engineMode").value === "local-ai" ? "Edit jawaban" : "Edit prompt";
  $("editPromptButton").setAttribute("aria-pressed", "false");
  $("assistantReplyIntro").textContent = $("engineMode").value === "local-ai"
    ? "RidTheWann Core sedang menyiapkan jawaban lokal."
    : "Aku sedang merapikan instruksi dan menjaga maksud awalmu.";
  $("assistantThinking").hidden = false;
  $("thinkingMessage").textContent = message;
  $("resultStatus").textContent = "Sedang diproses";
  $("originalPrompt").value = "";
  updateWordCounts();
  window.requestAnimationFrame(() => {
    $("assistantThinking").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function revealOutputPanel() {
  const panel = $("outputPanel");
  panel.hidden = false;
  panel.classList.add("has-result");
  $("assistantThinking").hidden = true;
  const welcome = $("chatWelcome");
  if (welcome) welcome.classList.add("has-conversation");
  const bubble = $("chatUserBubble");
  const bubbleText = $("chatUserPromptText");
  const promptVal = activePromptText || currentOriginal();
  if (bubble && bubbleText && promptVal) {
    bubbleText.textContent = promptVal;
    bubble.hidden = false;
  }
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function currentOriginal() {
  return activePromptText || $("originalPrompt").value.trim();
}

function renderPromptPreview() {
  const preview = $("promptPreview");
  if (preview) preview.textContent = $("improvedPrompt").value;
}

function renderWebSources(sources) {
  const container = $("webSources");
  const list = $("webSourceList");
  if (!container || !list) return;
  list.replaceChildren();
  for (const source of Array.isArray(sources) ? sources : []) {
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const link = document.createElement("a");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || source.domain || url.hostname;
    link.title = url.hostname;
    list.append(link);
  }
  container.hidden = list.childElementCount === 0;
}

function updateWordCounts() {
  const originalWords = wordCount($("originalPrompt").value.trim());
  const output = $("improvedPrompt").value;
  renderPromptPreview();
  $("wordCount").textContent = originalWords + " kata";
  $("inputHint").textContent = originalWords === 0
    ? "Satu kalimat sudah cukup. Detail tambahan bersifat opsional."
    : originalWords < 8
      ? "Tidak perlu membuat prompt panjang jika tugasnya sederhana."
      : "Tambahkan detail hanya jika benar-benar berpengaruh pada hasil.";
  $("resultWordCount").textContent = wordCount(output) + " kata";
  $("copyButton").disabled = !output.trim();
  $("downloadButton").disabled = !output.trim();
  $("saveButton").disabled = !output.trim() || !currentOriginal();
  $("exportJsonButton").disabled = !output.trim() || !currentOriginal();
  $("outputPanel").classList.toggle("has-result", Boolean(output.trim()));
}

function wordCount(value) {
  const text = String(value ?? "").trim();
  return text ? text.split(/\s+/).length : 0;
}

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  if ($("scoreBeforeValue")) {
    $("scoreBeforeValue").textContent = (analysis.beforeScore !== null && analysis.beforeScore !== undefined) ? analysis.beforeScore : "—";
  }
  $("scoreValue").textContent = (analysis.afterScore !== null && analysis.afterScore !== undefined) ? analysis.afterScore : analysis.score;
  $("scoreBar").style.width = analysis.score + "%";
  $("scoreSummary").textContent = analysis.summary || "Saran ini menilai kelengkapan struktur, bukan kebenaran jawaban AI.";
  $("resultStatus").textContent = analysis.wordCount ? "Analisis selesai" : "Menunggu input";
  const highlights = $("analysisHighlights");
  if (highlights) {
    highlights.replaceChildren();
    const task = document.createElement("p");
    task.className = "analysis-task-chip";
    task.textContent = "Jenis tugas terdeteksi: " + (analysis.taskLabel || "Umum");
    highlights.append(task);
    for (const warningText of (analysis.warnings || [])) {
      const warning = document.createElement("p");
      warning.className = "analysis-warning";
      warning.textContent = warningText;
      highlights.append(warning);
    }
    if ((analysis.recommendations || []).length) {
      const heading = document.createElement("strong");
      heading.className = "analysis-recommendation-heading";
      heading.textContent = "Yang bisa diperjelas (pilih yang relevan)";
      const list = document.createElement("ul");
      for (const item of analysis.recommendations) {
        const row = document.createElement("li");
        row.textContent = item.label + ": " + item.detail;
        list.append(row);
      }
      highlights.append(heading, list);
    }
  }

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
  const original = $("originalPrompt").value.trim() || activePromptText;
  if (!original) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return null;
  }
  const improvedPrompt = $("improvedPrompt").value.trim();
  const analysis = analyzePrompt(original, { ...readSettings(), improvedPrompt });
  renderAnalysis(analysis);
  $("analysisDetails").open = true;
  revealOutputPanel();
  return analysis;
}

function buildCurrentPrompt() {
  const original = $("originalPrompt").value.trim() || activePromptText;
  if (!original) {
    showToast("Isi prompt awal terlebih dahulu.");
    $("originalPrompt").focus();
    return null;
  }
  const settings = readSettings();
  try {
    const prompt = buildImprovedPrompt({ originalPrompt: original, ...settings });
    $("improvedPrompt").value = prompt;
    const analysis = analyzePrompt(original, { ...settings, improvedPrompt: prompt });
    renderAnalysis(analysis);
    updateWordCounts();
    $("resultStatus").textContent = "Prompt disusun";
    revealOutputPanel();
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
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
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
  invalidateActiveAiOperation("Versi riwayat dipulihkan");
  activePromptText = version.originalPrompt;
  activeWebSources = [];
  renderWebSources([]);
  $("improvedPrompt").hidden = true;
  $("promptPreview").hidden = false;
  $("editPromptButton").textContent = $("engineMode").value === "local-ai" ? "Edit jawaban" : "Edit prompt";
  $("editPromptButton").setAttribute("aria-pressed", "false");
  localConversation = [];
  renderLocalConversationArchive();
  const settings = version.settings ?? {};
  $("originalPrompt").value = "";
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
  revealOutputPanel();
  $("originalPrompt").focus();
  showToast("Versi berhasil dipulihkan. Kamu bisa lanjut mengiterasikannya.");
  $("originalPrompt").scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearWorkspace() {
  invalidateActiveAiOperation("Workspace baru dibuka");
  localConversation = [];
  renderLocalConversationArchive();
  activePromptText = "";
  activeWebSources = [];
  renderWebSources([]);
  $("improvedPrompt").hidden = true;
  $("promptPreview").hidden = false;
  $("editPromptButton").textContent = "Edit prompt";
  $("editPromptButton").setAttribute("aria-pressed", "false");
  for (const id of fields) {
    if (id === "outputFormat") $(id).value = "auto";
    else $(id).value = "";
  }
  for (const id of ruleIds) $(id).checked = true;
  $("iterationFeedback").value = "";
  $("improvedPrompt").value = "";
  iterationNotes = [];
  lastAnalysis = null;
  $("outputPanel").hidden = true;
  $("assistantThinking").hidden = true;
  $("contextDetails").open = false;
  $("contextDetails").hidden = true;
  toggleComposerMenu(false);
  toggleSidebar(false);
  $("scoreBeforeValue").textContent = "—";
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

  const bubble = $("chatUserBubble");
  if (bubble) bubble.hidden = true;
  const bubbleText = $("chatUserPromptText");
  if (bubbleText) bubbleText.textContent = "";
  const welcome = $("chatWelcome");
  if (welcome) welcome.classList.remove("has-conversation");
  const panel = $("outputPanel");
  if (panel) panel.classList.remove("has-result");

  updateWordCounts();
  showToast("Workspace baru siap. Riwayat tersimpan tetap aman.");
  $("originalPrompt").focus();
}

$("originalPrompt").addEventListener("input", updateWordCounts);
$("reasoningEffort").addEventListener("change", () => { saveReasoningPrefs(); updateEngineLabel(); });
$("webSearchEnabled").addEventListener("change", () => { saveReasoningPrefs(); updateEngineLabel(); });
$("editPromptButton").addEventListener("click", () => {
  const editing = !$("improvedPrompt").hidden;
  $("improvedPrompt").hidden = editing;
  $("promptPreview").hidden = !editing;
  $("editPromptButton").textContent = editing
    ? ($("engineMode").value === "local-ai" ? "Edit jawaban" : "Edit prompt")
    : "Selesai mengedit";
  $("editPromptButton").setAttribute("aria-pressed", String(!editing));
  if (editing) {
    renderPromptPreview();
    $("promptPreview").focus();
  } else {
    $("improvedPrompt").focus();
  }
});
$("improvedPrompt").addEventListener("input", () => {
  updateWordCounts();
  const original = currentOriginal();
  if (original && lastAnalysis) {
    const analysis = analyzePrompt(original, { ...readSettings(), improvedPrompt: $("improvedPrompt").value.trim() });
    renderAnalysis(analysis);
  }
});
$("analyzeButton").addEventListener("click", analyzeCurrentPrompt);
$("improveButton").addEventListener("click", runSelectedEngine);
$("cancelImproveButton").addEventListener("click", cancelAiImprovement);
$("loadLocalModelButton").addEventListener("click", loadLocalModelFromSettings);
$("checkLlmButton").addEventListener("click", checkLlmConnection);
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
$("llmProvider").addEventListener("change", () => {
  llmModels = [];
  llmConfig.model = "";
  populateLlmModels([], "");
  updateProviderFields();
  saveLlmConfig();
  setLlmStatus("Penyedia diganti. Masukkan API key lalu cek koneksi.");
});
$("llmApiKey").addEventListener("change", saveLlmConfig);
$("llmModel").addEventListener("change", saveLlmConfig);
$("llmEndpoint").addEventListener("change", () => {
  llmModels = [];
  saveLlmConfig();
  setLlmStatus("Alamat berubah. Cek koneksi kembali untuk memuat model.");
});
for (const id of [...new Set([...fields, ...ruleIds, "improvedPrompt", "iterationFeedback", "engineMode", "llmProvider", "llmEndpoint", "llmApiKey", "llmModel"])]) {
  const field = $(id);
  const invalidateFromEdit = () => invalidateActiveAiOperation("input atau pengaturan berubah saat AI bekerja", true);
  field.addEventListener("input", invalidateFromEdit);
  field.addEventListener("change", invalidateFromEdit);
}
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
  runSelectedEngine({ reuseActivePrompt: true });
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

function renderTemplates() {
  const list = $("templateList");
  list.replaceChildren();
  for (const item of PROMPT_TEMPLATES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "template-chip";
    chip.dataset.template = item.id;
    chip.textContent = item.label;
    list.append(chip);
  }
}

function toggleSidebar(force) {
  const sidebar = $("chatSidebar");
  const backdrop = $("sidebarBackdrop");
  const toggleBtn = $("sidebarToggle");
  if (!sidebar || !backdrop || !toggleBtn) return;
  const open = typeof force === "boolean" ? force : !sidebar.classList.contains("open");
  sidebar.classList.toggle("open", open);
  backdrop.classList.toggle("open", open);
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  backdrop.setAttribute("aria-hidden", String(!open));
  toggleBtn.setAttribute("aria-expanded", String(open));
}

function toggleComposerMenu(force) {
  const menu = $("composerMenu");
  const button = $("composerPlusButton");
  if (!menu || !button) return;
  const open = typeof force === "boolean" ? force : menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function applyTemplate(id) {
  const template = getTemplate(id);
  if (!template) return;
  const hasWork = currentOriginal() || $("improvedPrompt").value.trim();
  if (hasWork && !window.confirm("Ganti isi editor dengan contoh \"" + template.label + "\"? Riwayat tersimpan tidak terhapus.")) return;
  invalidateActiveAiOperation("Template diganti", true);
  for (const key of fields) {
    $(key).value = key === "originalPrompt" ? template.prompt : template[key] ?? (key === "outputFormat" ? "auto" : "");
  }
  $("improvedPrompt").value = "";
  $("improvedPrompt").hidden = true;
  $("promptPreview").hidden = false;
  $("editPromptButton").textContent = "Edit prompt";
  $("editPromptButton").setAttribute("aria-pressed", "false");
  activePromptText = "";
  activeWebSources = [];
  renderWebSources([]);
  $("chatUserBubble").hidden = true;
  $("chatUserPromptText").textContent = "";
  $("outputPanel").hidden = true;
  $("assistantThinking").hidden = true;
  $("chatWelcome").classList.remove("has-conversation");
  iterationNotes = [];
  updateWordCounts();
  toggleComposerMenu(false);
  toggleSidebar(false);
  $("originalPrompt").focus();
  showToast("Contoh dimuat. Ganti bagian [dalam kurung] dengan kebutuhanmu.");
}

function setAdvancedMode(enabled, persist = true) {
  $("evaluationSection").hidden = !enabled;
  document.body.classList.toggle("advanced-mode", enabled);
  if (enabled) $("engineSettings").open = true;
  $("advancedToggle").setAttribute("aria-pressed", String(enabled));
  $("advancedToggle").textContent = enabled ? "Mode lanjutan: aktif" : "Mode lanjutan";
  if (!persist) return;
  try { localStorage.setItem(ADVANCED_KEY, enabled ? "1" : "0"); } catch { /* preferensi tidak wajib tersimpan */ }
}

$("sidebarToggle").addEventListener("click", () => toggleSidebar());
$("sidebarBackdrop").addEventListener("click", () => toggleSidebar(false));
$("composerPlusButton").addEventListener("click", () => toggleComposerMenu());
$("contextDetails").addEventListener("toggle", () => {
  // Keep the composer compact again after optional details are collapsed.
  if (!$("contextDetails").open) $("contextDetails").hidden = true;
});
$("composerMenu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-composer-action]");
  if (!button) return;
  const action = button.dataset.composerAction;
  toggleComposerMenu(false);

  if (action === "new") {
    clearWorkspace();
    return;
  }
  if (action === "context") {
    $("contextDetails").hidden = false;
    $("contextDetails").open = true;
    $("objective").focus();
    return;
  }
  if (action === "engine") {
    toggleSidebar(true);
    $("engineSettings").open = true;
    $("engineSettings").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  if (action === "history") {
    toggleSidebar(true);
    $("historyList").closest(".sidebar-section").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "advanced") {
    setAdvancedMode($("advancedToggle").getAttribute("aria-pressed") !== "true");
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".composer-tools")) toggleComposerMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  toggleComposerMenu(false);
  if ($("chatSidebar").classList.contains("open")) toggleSidebar(false);
});
$("templateList").addEventListener("click", (event) => {
  const chip = event.target.closest("button[data-template]");
  if (chip) applyTemplate(chip.dataset.template);
});
$("advancedToggle").addEventListener("click", () => setAdvancedMode($("advancedToggle").getAttribute("aria-pressed") !== "true"));
$("originalPrompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    runSelectedEngine();
  }
});

updateWordCounts();
renderTemplates();
try { setAdvancedMode(localStorage.getItem(ADVANCED_KEY) === "1", false); } catch { setAdvancedMode(false, false); }
renderHistory();
initializeLlmSettings();
renderEvaluationCases();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // The workbench remains usable if service-worker registration is blocked.
    });
  });
}