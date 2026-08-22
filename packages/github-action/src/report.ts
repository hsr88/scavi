import type { CheckResult } from "@scavi/core";

function safe(value: string): string { return value.replace(/[\\`*_[\]{}<>#+.!|()-]/g, "\\$&").replace(/\r?\n/g, " ") }

export function buildMarkdownReport(result: CheckResult, changedFiles: string[]): string {
  const lines = ["## 🐾 Scavi Context Check", "", `**${result.summary.total} ${result.summary.total === 1 ? "issue" : "issues"} found**`, "", `- Errors: ${result.summary.errors}`, `- Warnings: ${result.summary.warnings}`, `- Context files: ${result.contextFiles.length}`];
  if (changedFiles.length) {
    lines.push("", `<details><summary>${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"} considered</summary>`, "");
    changedFiles.slice(0, 100).forEach((file) => lines.push(`- \`${safe(file)}\``));
    if (changedFiles.length > 100) lines.push(`- …and ${changedFiles.length - 100} more`);
    lines.push("", "</details>");
  }
  for (const issue of result.issues) {
    const marker = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
    lines.push("", `### ${marker} ${safe(issue.id)}`, "", `**${safe(issue.source.file)}:${issue.source.line}**`, "", safe(issue.message));
    if (issue.claim) lines.push("", `> ${safe(issue.claim)}`);
    if (issue.confidence !== undefined) lines.push("", `Confidence: **${Math.round(issue.confidence * 100)}%**`);
    if (issue.evidence.length) {
      lines.push("", "Evidence:");
      issue.evidence.forEach((item) => lines.push(`- ${item.file ? `\`${safe(item.file)}\`: ` : ""}${safe(item.description)}`));
    }
  }
  if (result.summary.total === 0) lines.push("", "✅ No context issues found.");
  return `${lines.join("\n")}\n`;
}
