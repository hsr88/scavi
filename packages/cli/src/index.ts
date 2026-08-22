#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { applyFixes, checkRepository, exitCodeFor, initRepository, previewFixes, type CheckResult, type InitResult } from "@scavi/core";

function renderText(result: CheckResult): string {
  const lines = ["🐾 Scavi is digging through your repo...", "", "Context files:"];
  if (result.contextFiles.length === 0) lines.push("  None found");
  else result.contextFiles.forEach((file) => lines.push(`  ✓ ${file.relativePath}`));
  lines.push("", "Repository checks:");
  if (result.issues.length === 0) lines.push("", "✓ No deterministic issues found.");
  for (const issue of result.issues) {
    const marker = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
    lines.push("", `${marker} ${issue.source.file}:${issue.source.line}`, `  ${issue.id}`, "", `  ${issue.message}`);
    if (issue.claim) lines.push("", `  ${issue.claim}`);
    if (issue.evidence.length) {
      lines.push("", "  Evidence:");
      issue.evidence.forEach((item) => lines.push(`    ${item.file ? `${item.file}: ` : ""}${item.description}`));
    }
  }
  lines.push("", "Summary:", `  ${result.summary.errors} errors`, `  ${result.summary.warnings} warnings`, `  ${result.summary.total} issues`);
  if (result.semanticFindings.length) {
    lines.push("", "Semantic verification:");
    for (const finding of result.semanticFindings) {
      lines.push("", `  ${finding.source.file}:${finding.source.line}`, `  ${finding.verdict.toUpperCase()} (${Math.round(finding.confidence * 100)}%)`, `  ${finding.claim}`, `  ${finding.reason}`);
      finding.evidence.forEach((item) => lines.push(`    ${item.file}:${item.startLine}-${item.endLine}`));
    }
  }
  return lines.join("\n");
}

function usage(): string { return "Usage:\n  scavi init [path]\n  scavi check [path] [--format text|json]\n  scavi fix [path]" }

function renderInit(result: InitResult): string {
  const relative = result.configPath.slice(result.root.length + 1);
  const lines = ["🐾 Scavi initialization", "", `Repository:\n  ${result.root}`, "", "Detected context:"];
  if (result.contextFiles.length) result.contextFiles.forEach((file) => lines.push(`  ✓ ${file}`));
  else lines.push("  None found yet");
  if (result.packageManager) lines.push("", `Package manager:\n  ${result.packageManager}`);
  lines.push("", result.created ? `Created:\n  ${relative}` : `Not changed:\n  ${relative} already exists`, "", "Run:\n  scavi check");
  return lines.join("\n");
}

function jsonReport(result: CheckResult): unknown {
  return {
    root: result.root,
    contextFiles: result.contextFiles.map((file) => file.relativePath),
    repository: {
      packageManager: result.facts.packageManager,
      packageManagerEvidence: result.facts.packageManagerEvidence,
      scripts: [...result.facts.scripts],
      dependencies: result.facts.dependencies,
    },
    issues: result.issues,
    semanticFindings: result.semanticFindings,
    summary: result.summary,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "init") {
    if (args.length > 2) { console.error(usage()); process.exitCode = 2; return }
    try { console.log(renderInit(await initRepository(args[1]))); process.exitCode = 0 }
    catch (error) { console.error(`Scavi failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2 }
    return;
  }
  if (args[0] === "fix") {
    if (args.length > 2) { console.error(usage()); process.exitCode = 2; return }
    try {
      const result = await checkRepository(args[1]);
      const fixable = result.issues.filter((issue) => issue.fix);
      if (fixable.length === 0) {
        console.log(result.issues.length === 0 ? "✓ No issues found." : "No deterministic fixes are available for the current issues.");
        process.exitCode = exitCodeFor(result);
        return;
      }
      console.log("🐾 Scavi prepared deterministic fixes:\n");
      console.log(await previewFixes(result));
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question("\nApply these fixes? [y/N] ");
      prompt.close();
      if (!/^y(?:es)?$/i.test(answer.trim())) { console.log("No files changed."); process.exitCode = exitCodeFor(result); return }
      const applied = await applyFixes(result);
      console.log(`Applied ${applied} minimal ${applied === 1 ? "edit" : "edits"}.`);
      process.exitCode = exitCodeFor(await checkRepository(args[1]));
    } catch (error) {
      console.error(`Scavi failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
    return;
  }
  if (args[0] !== "check") { console.error(usage()); process.exitCode = 2; return }
  const formatIndex = args.indexOf("--format");
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "text";
  if (format !== "text" && format !== "json") { console.error("Invalid --format. Expected text or json."); process.exitCode = 2; return }
  const positional = args.slice(1).filter((arg, index) => arg !== "--format" && args[index] !== "--format");
  if (positional.length > 1) { console.error(usage()); process.exitCode = 2; return }
  try {
    const result = await checkRepository(positional[0]);
    console.log(format === "json" ? JSON.stringify(jsonReport(result), null, 2) : renderText(result));
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    console.error(`Scavi failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

await main();
