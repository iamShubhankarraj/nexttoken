/**
 * Unit tests for src/main/voice/cleanup.ts.
 * Mirrors the #[cfg(test)] cases in Flow's quickclean.rs plus the
 * format.rs guard cases. Run: node scripts/test-cleanup.mjs
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "nt-cleanup-test-"));
execFileSync(
  path.join(root, "node_modules", ".bin", "tsc"),
  [
    "--outDir", outDir,
    "--module", "nodenext",
    "--moduleResolution", "nodenext",
    "--target", "es2022",
    "--strict",
    path.join(root, "src", "main", "voice", "cleanup.ts"),
  ],
  { stdio: "pipe" },
);

const cleanup = await import(
  pathToFileURL(path.join(outDir, "cleanup.js")).href
);
const { tryQuickClean, stripReasoning, keepsSpeakerWords, acceptFormatterOutput } = cleanup;

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

t("disabled returns null", () => assert.equal(tryQuickClean("send the report", 12, false), null));
t("empty returns null", () => {
  assert.equal(tryQuickClean("", 12, true), null);
  assert.equal(tryQuickClean("   \n\t ", 12, true), null);
});
t("at/above threshold defers", () => {
  assert.equal(tryQuickClean("one two three four five", 5, true), null);
  assert.equal(tryQuickClean("one two three four five six", 5, true), null);
});
t("enumeration markers defer", () => {
  assert.equal(tryQuickClean("first buy milk second buy eggs", 20, true), null);
  assert.equal(tryQuickClean("give me a list of items", 20, true), null);
  assert.equal(tryQuickClean("primero comprar leche segundo pan", 20, true), null);
});
t("spoken punctuation markers defer", () => {
  assert.equal(tryQuickClean("send it comma then wait", 20, true), null);
  assert.equal(tryQuickClean("write this new line and that", 20, true), null);
  assert.equal(tryQuickClean("buy 1. milk 2. eggs", 20, true), null);
});
t("short english fillers cleaned", () =>
  assert.equal(tryQuickClean("so um send the uh report you know", 20, true), "Send the report."));
t("spanish leading filler cleaned", () =>
  assert.equal(tryQuickClean("eh mandame el informe mañana", 12, true), "Mandame el informe mañana."));
t("idempotent on clean text", () => {
  const once = tryQuickClean("Send the report.", 12, true);
  assert.equal(once, "Send the report.");
  assert.equal(tryQuickClean(once, 12, true), once);
});
t("question mark preserved", () =>
  assert.equal(tryQuickClean("can you send it?", 12, true), "Can you send it?"));
t("fillers-only returns null", () =>
  assert.equal(tryQuickClean("um uh you know", 12, true), null));
t("interior spanish este preserved", () =>
  assert.equal(tryQuickClean("quiero este informe", 12, true), "Quiero este informe."));
t("leading spanish este stripped", () =>
  assert.equal(tryQuickClean("este mandame el informe", 12, true), "Mandame el informe."));
t("interior eh preserved, leading eh stripped", () => {
  assert.equal(
    tryQuickClean("mandame el informe eh mañana", 12, true),
    "Mandame el informe eh mañana.",
  );
  assert.equal(
    tryQuickClean("eh mandame el informe mañana", 12, true),
    "Mandame el informe mañana.",
  );
});
t("stripReasoning removes think blocks", () => {
  assert.equal(
    stripReasoning("<think>reasoning here</think>Clean text."),
    "Clean text.",
  );
  assert.equal(stripReasoning("No block here."), "No block here.");
});
t("keepsSpeakerWords guards assistant-mode slip", () => {
  assert.equal(keepsSpeakerWords("buy milk and eggs", "Buy milk and eggs."), true);
  assert.equal(
    keepsSpeakerWords("buy milk and eggs", "Okay, I understand. I will help you with that."),
    false,
  );
  assert.equal(keepsSpeakerWords("buy milk", ""), false);
});
t("acceptFormatterOutput rejects empty", () =>
  assert.equal(acceptFormatterOutput("buy milk", "   "), false));

console.log(`\n${n} tests passed.`);
