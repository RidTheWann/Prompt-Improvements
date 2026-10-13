import { normalizeEvaluationCase } from "./evaluation.js";
import { normalizeOllamaBaseUrl } from "./ollama-client.js";

export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_WORKSPACE_FILE_CHARS = 2 * 1024 * 1024;
const OUTPUT_FORMATS = new Set(["auto", "markdown", "json", "code", "table", "checklist", "prose"]);
const FIELD_LIMITS = {
  originalPrompt: 60000,
  objective: 12000,
  context: 24000,
  audience: 4000,
  constraints: 12000,
  outputFormat: 32,
  successCriteria: 12000,
  improvedPrompt: 60000
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name, maxLength, { allowEmpty = true } = {}) {
  if (typeof value !== "string") throw new Error(name + " harus berupa teks.");
  if (!allowEmpty && !value.trim()) throw new Error(name + " tidak boleh kosong.");
  if (value.length > maxLength) throw new Error(name + " melebihi batas " + maxLength + " karakter.");
  return value;
}

function normalizeStringList(value, label, maxItems, itemMax) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(label + " harus berupa daftar.");
  if (value.length > maxItems) throw new Error(label + " maksimal " + maxItems + " item.");
  return value.map((item, index) => requireString(item, label + " #" + (index + 1), itemMax, { allowEmpty: false }));
}

function uniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(label + " memiliki ID duplikat: " + item.id);
    seen.add(item.id);
  }
  return items;
}

function normalizeSettings(settings = {}, iterationNotes = []) {
  if (!isRecord(settings)) throw new Error("Pengaturan versi harus berupa objek.");
  const outputFormat = typeof settings.outputFormat === "string" ? settings.outputFormat : "auto";
  if (!OUTPUT_FORMATS.has(outputFormat)) throw new Error("Format keluaran tidak dikenal: " + outputFormat);
  const safeguards = isRecord(settings.safeguards) ? settings.safeguards : {};
  return {
    objective: typeof settings.objective === "string" ? requireString(settings.objective, "Tujuan versi", 12000) : "",
    context: typeof settings.context === "string" ? requireString(settings.context, "Konteks versi", 24000) : "",
    audience: typeof settings.audience === "string" ? requireString(settings.audience, "Audiens versi", 4000) : "",
    constraints: typeof settings.constraints === "string" ? requireString(settings.constraints, "Batasan versi", 12000) : "",
    outputFormat,
    successCriteria: typeof settings.successCriteria === "string" ? requireString(settings.successCriteria, "Kriteria keberhasilan versi", 12000) : "",
    safeguards: {
      preserveIntent: safeguards.preserveIntent !== false,
      avoidFabrication: safeguards.avoidFabrication !== false,
      review: safeguards.review !== false
    },
    iterationNotes: normalizeStringList(iterationNotes, "Catatan iterasi", 50, 2000)
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) throw new Error("Riwayat versi harus berupa daftar.");
  if (value.length > 50) throw new Error("Backup berisi lebih dari 50 versi.");
  const history = value.map((item, index) => {
    const label = "Versi #" + (index + 1);
    if (!isRecord(item)) throw new Error(label + " tidak valid.");
    const id = requireString(item.id, label + " ID", 160, { allowEmpty: false });
    const originalPrompt = requireString(item.originalPrompt, label + " prompt awal", 60000, { allowEmpty: false });
    const improvedPrompt = requireString(item.improvedPrompt, label + " prompt revisi", 60000, { allowEmpty: false });
    const createdAt = typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
      ? new Date(item.createdAt).toISOString()
      : null;
    if (!createdAt) throw new Error(label + " memiliki tanggal yang tidak valid.");
    const notes = normalizeStringList(item.iterationNotes ?? item.settings?.iterationNotes, label + " catatan iterasi", 50, 2000);
    return {
      id,
      createdAt,
      originalPrompt,
      settings: normalizeSettings(item.settings ?? {}, notes),
      iterationNotes: notes,
      improvedPrompt
    };
  });
  return uniqueIds(history, "Riwayat versi");
}

function normalizeCases(value) {
  if (!Array.isArray(value)) throw new Error("Test case harus berupa daftar.");
  if (value.length > 20) throw new Error("Backup berisi lebih dari 20 test case.");
  const cases = value.map((item, index) => {
    if (!isRecord(item)) throw new Error("Test case #" + (index + 1) + " tidak valid.");
    const normalized = normalizeEvaluationCase(item);
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "imported-case-" + (index + 1);
    if (id.length > 160) throw new Error("ID test case terlalu panjang.");
    return { ...normalized, id };
  });
  return uniqueIds(cases, "Test case");
}

export function validateWorkspaceBackup(value) {
  if (!isRecord(value)) throw new Error("File backup harus berisi objek JSON.");
  if (value.app !== "Prompt Improvements") throw new Error("File ini bukan backup Prompt Improvements.");
  if (value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error("Versi skema backup tidak didukung: " + String(value.schemaVersion));
  }
  const workspace = value.workspace;
  if (!isRecord(workspace) || !isRecord(workspace.fields)) throw new Error("Bagian workspace tidak lengkap.");
  const fields = {};
  for (const [key, maxLength] of Object.entries(FIELD_LIMITS)) {
    fields[key] = requireString(workspace.fields[key] ?? "", "Field " + key, maxLength);
  }
  if (!OUTPUT_FORMATS.has(fields.outputFormat)) throw new Error("Format keluaran tidak dikenal: " + fields.outputFormat);

  const safeguardsInput = isRecord(workspace.safeguards) ? workspace.safeguards : {};
  const iterationNotes = normalizeStringList(workspace.iterationNotes, "Catatan iterasi workspace", 50, 2000);
  const engine = workspace.engine;
  if (!isRecord(engine)) throw new Error("Pengaturan engine tidak lengkap.");
  if (!["rules", "ollama"].includes(engine.mode)) throw new Error("Mode engine tidak didukung.");
  const model = requireString(engine.model ?? "", "Nama model", 200);
  let endpoint;
  try {
    endpoint = normalizeOllamaBaseUrl(engine.endpoint ?? "http://localhost:11434");
  } catch {
    throw new Error("Backup berisi endpoint Ollama yang tidak diizinkan. Hanya alamat loopback lokal yang didukung.");
  }
  const exportedAt = typeof value.exportedAt === "string" && Number.isFinite(Date.parse(value.exportedAt))
    ? new Date(value.exportedAt).toISOString()
    : null;
  if (!exportedAt) throw new Error("Tanggal ekspor backup tidak valid.");

  return {
    app: "Prompt Improvements",
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    exportedAt,
    workspace: {
      fields,
      safeguards: {
        preserveIntent: safeguardsInput.preserveIntent !== false,
        avoidFabrication: safeguardsInput.avoidFabrication !== false,
        review: safeguardsInput.review !== false
      },
      iterationNotes,
      engine: { mode: engine.mode, model, endpoint }
    },
    history: normalizeHistory(value.history ?? []),
    evaluationCases: normalizeCases(value.evaluationCases ?? [])
  };
}

export function createWorkspaceBackup(input = {}) {
  if (!isRecord(input)) throw new Error("Data workspace tidak valid.");
  return validateWorkspaceBackup({
    app: "Prompt Improvements",
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: input.workspace,
    history: input.history ?? [],
    evaluationCases: input.evaluationCases ?? []
  });
}

export function parseWorkspaceBackup(text) {
  if (typeof text !== "string") throw new Error("Isi file backup harus berupa teks.");
  if (text.length > MAX_WORKSPACE_FILE_CHARS) throw new Error("File backup melebihi batas 2 MiB.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File backup bukan JSON yang valid.");
  }
  return validateWorkspaceBackup(parsed);
}
