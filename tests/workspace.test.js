import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceBackup,
  parseWorkspaceBackup,
  validateWorkspaceBackup,
  MAX_WORKSPACE_FILE_CHARS
} from "../src/workspace.js";

function fixture() {
  return {
    workspace: {
      fields: {
        originalPrompt: "Build a REST API.",
        objective: "Create a tested API.",
        context: "Existing JavaScript project.",
        audience: "Developer",
        constraints: "No paid APIs.",
        outputFormat: "markdown",
        successCriteria: "Tests pass.",
        improvedPrompt: "Build a REST API with clear requirements."
      },
      safeguards: { preserveIntent: true, avoidFabrication: true, review: false },
      iterationNotes: ["Keep existing public interfaces."],
      engine: { mode: "rules", model: "", endpoint: "http://localhost:11434" }
    },
    history: [{
      id: "version-1",
      createdAt: "2026-10-14T00:00:00.000Z",
      originalPrompt: "Build a REST API.",
      settings: { objective: "Create a tested API.", outputFormat: "markdown" },
      iterationNotes: ["Keep existing public interfaces."],
      improvedPrompt: "Build a REST API with clear requirements."
    }],
    evaluationCases: [{
      id: "case-1", name: "JSON API contract", input: "Return an object.",
      requiredText: ["summary"], forbiddenText: ["lorem"], requireJson: true,
      requiredKeys: ["summary"], maxWords: 60
    }]
  };
}

test("workspace backup round-trips editor, safeguards, history, and test cases", () => {
  const backup = createWorkspaceBackup(fixture());
  assert.equal(backup.app, "Prompt Improvements");
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.workspace.fields.originalPrompt, "Build a REST API.");
  assert.equal(backup.workspace.safeguards.review, false);
  assert.equal(backup.history.length, 1);
  assert.equal(backup.history[0].analysis, undefined);
  assert.equal(backup.evaluationCases[0].requiredKeys[0], "summary");
  assert.deepEqual(parseWorkspaceBackup(JSON.stringify(backup)), backup);
});

test("workspace validation rejects unsupported app or schema versions", () => {
  const backup = createWorkspaceBackup(fixture());
  assert.throws(() => validateWorkspaceBackup({ ...backup, app: "Other App" }), /bukan backup/);
  assert.throws(() => validateWorkspaceBackup({ ...backup, schemaVersion: 99 }), /tidak didukung/);
});

test("workspace validation restricts Ollama endpoints to loopback", () => {
  const backup = createWorkspaceBackup(fixture());
  backup.workspace.engine.endpoint = "https://example.com:11434";
  assert.throws(() => validateWorkspaceBackup(backup), /endpoint Ollama yang tidak diizinkan/);
  backup.workspace.engine.endpoint = "http://user:password@localhost:11434";
  assert.throws(() => validateWorkspaceBackup(backup), /endpoint Ollama yang tidak diizinkan/);
});

test("workspace validation enforces file, history, and test-case limits", () => {
  assert.throws(() => parseWorkspaceBackup("x".repeat(MAX_WORKSPACE_FILE_CHARS + 1)), /2 MiB/);
  const backup = createWorkspaceBackup(fixture());
  assert.throws(() => validateWorkspaceBackup({ ...backup, history: Array(51).fill(backup.history[0]) }), /lebih dari 50 versi/);
  assert.throws(() => validateWorkspaceBackup({ ...backup, evaluationCases: Array(21).fill(backup.evaluationCases[0]) }), /lebih dari 20 test case/);
});

test("workspace validation rejects duplicate identifiers and malformed test cases", () => {
  const backup = createWorkspaceBackup(fixture());
  backup.history.push({ ...backup.history[0], improvedPrompt: "Another prompt" });
  assert.throws(() => validateWorkspaceBackup(backup), /ID duplikat/);
  const malformed = createWorkspaceBackup(fixture());
  malformed.evaluationCases[0].maxWords = -1;
  assert.throws(() => validateWorkspaceBackup(malformed), /Batas kata/);
});

test("workspace backup rejects unknown formats and unsupported engine modes", () => {
  const backup = createWorkspaceBackup(fixture());
  backup.workspace.fields.outputFormat = "made-up";
  assert.throws(() => validateWorkspaceBackup(backup), /Format keluaran tidak dikenal/);
  const another = createWorkspaceBackup(fixture());
  another.workspace.engine.mode = "cloud-paid";
  assert.throws(() => validateWorkspaceBackup(another), /Mode engine tidak didukung/);
});

test("workspace parser rejects invalid JSON and incomplete payloads", () => {
  assert.throws(() => parseWorkspaceBackup("{"), /JSON yang valid/);
  assert.throws(() => validateWorkspaceBackup({ app: "Prompt Improvements", schemaVersion: 1 }), /workspace tidak lengkap/);
});
