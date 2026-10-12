import { analyzePrompt, buildImprovedPrompt, createExportPayload } from "./prompt-engine.js";

const STORAGE_KEY = "prompt-improvements.history.v1";
const MAX_HISTORY = 50;
const $ = (id) => document.getElementById(id);

let savedVersions = loadHistory();
let lastAnalysis = null;
let iterationNotes = [];
let toastTimer = null;

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
$("improveButton").addEventListener("click", () => {
  if (buildCurrentPrompt()) showToast("Prompt terstruktur berhasil dibuat. Tinjau dan sesuaikan sebelum digunakan.");
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
  if (buildCurrentPrompt()) {
    $("resultStatus").textContent = "Iterasi " + iterationNotes.length;
    showToast("Iterasi diperbarui. Prompt awal dan feedback sebelumnya tetap dipertahankan.");
  }
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

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // The workbench remains usable if service-worker registration is blocked.
    });
  });
}