import { describe, expect, it } from "vitest";
import { buildMarkdownReport, filterResultForChanges } from "../src/report.js";
import type { CheckResult } from "@scavi/core";

describe("buildMarkdownReport", () => {
  it("renders CI findings and escapes untrusted Markdown", () => {
    const result = { root: "/repo", contextFiles: [], facts: { root: "/repo", packageManagerEvidence: [], scripts: new Set(), dependencies: {} }, semanticFindings: [], issues: [{ id: "STALE_PATH", rule: "valid-path", severity: "error", source: { file: "AGENTS.md", line: 3 }, message: "Missing <script>", claim: "Use `bad`", evidence: [] }], summary: { errors: 1, warnings: 0, infos: 0, total: 1 } } as CheckResult;
    const report = buildMarkdownReport(result, ["src/<unsafe>.ts"]);
    expect(report).toContain("Scavi Context Check");
    expect(report).not.toContain("<script>");
    expect(report).toContain("\\<script\\>");
    expect(report).toContain("src/\\<unsafe\\>\\.ts");
    expect(report).toContain("Infos: 0");
  });

  it("reports only issues affected by PR changes", () => {
    const base = { root: "/repo", contextFiles: [], facts: { root: "/repo", packageManagerEvidence: [], scripts: new Set(), dependencies: {} }, semanticFindings: [], issues: [
      { id: "OLD", rule: "valid-path", severity: "error", source: { file: "AGENTS.md", line: 1 }, message: "old", evidence: [] },
      { id: "NEW", rule: "valid-path", severity: "error", source: { file: "CLAUDE.md", line: 1 }, message: "new", evidence: [] },
    ], summary: { errors: 2, warnings: 0, infos: 0, total: 2 } } as CheckResult;
    const filtered = filterResultForChanges(base, ["CLAUDE.md"]);
    expect(filtered.issues.map((issue) => issue.id)).toEqual(["NEW"]);
    expect(filtered.summary).toMatchObject({ errors: 1, total: 1 });
  });
});
