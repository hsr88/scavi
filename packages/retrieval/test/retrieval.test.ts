import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { indexRepository, retrieveEvidence } from "../src/index.js";

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

describe("indexRepository", () => {
  it("sorts deterministically before applying maxFiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-retrieval-"));
    try {
      await writeFile(path.join(root, "z.ts"), "export const z = 1;\n", "utf8");
      await writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      expect((await indexRepository(root, { maxFiles: 1 }))[0]?.file).toBe("a.ts");
    } finally { await rm(root, { recursive: true, force: true }) }
  });
});
