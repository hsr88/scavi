import { describe, expect, it } from "vitest";
import { buildMarkdownReport } from "../src/report.js";
import type { CheckResult } from "@scavi/core";

describe("buildMarkdownReport", () => {
  it("renders CI findings and escapes untrusted Markdown", () => {
    const result = { root: "/repo", contextFiles: [], facts: { root: "/repo", packageManagerEvidence: [], scripts: new Set(), dependencies: {} }, semanticFindings: [], issues: [{ id: "STALE_PATH", rule: "valid-path", severity: "error", source: { file: "AGENTS.md", line: 3 }, message: "Missing <script>", claim: "Use `bad`", evidence: [] }], summary: { errors: 1, warnings: 0, infos: 0, total: 1 } } as CheckResult;
    const report = buildMarkdownReport(result, ["src/<unsafe>.ts"]);
    expect(report).toContain("Scavi Context Check");
    expect(report).not.toContain("<script>");
    expect(report).toContain("\\<script\\>");
    expect(report).toContain("src/\\<unsafe\\>\\.ts");
  });
});
