import { describe, expect, it } from "vitest";
import { retrieveEvidence } from "../src/index.js";

describe("retrieveEvidence", () => {
  it("ranks relevant repository evidence above unrelated chunks", () => {
    const evidence = retrieveEvidence("Configuration is persisted in SQLite storage", [
      { file: "src/ui.ts", startLine: 1, endLine: 2, content: "export function renderButton() {}" },
      { file: "src/storage/settings.ts", startLine: 1, endLine: 3, content: "const database = openSqlite();\nexport function persistSettings() {}" },
    ]);
    expect(evidence[0]?.file).toBe("src/storage/settings.ts");
    expect(evidence[0]?.score).toBeGreaterThan(0);
  });
});
