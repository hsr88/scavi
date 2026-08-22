import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import type { SemanticProvider } from "@scavi/ai";
import { applyFixes, checkRepository, exitCodeFor, initRepository, loadConfig, previewFixes } from "../src/index.js";

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");

describe("checkRepository", () => {
  it("returns no findings for a clean repository", async () => {
    const result = await checkRepository(path.join(fixtures, "clean-repo"));
    expect(result.issues).toEqual([]);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("detects stale paths, scripts, package managers, and conflicts", async () => {
    const result = await checkRepository(path.join(fixtures, "broken-repo"));
    expect(result.issues.map((issue) => issue.id)).toEqual(expect.arrayContaining(["STALE_PATH", "MISSING_REFERENCED_FILE", "INVALID_COMMAND", "PACKAGE_MANAGER_MISMATCH", "CONTEXT_CONFLICT", "DEPENDENCY_VERSION_MISMATCH"]));
    expect(exitCodeFor(result)).toBe(1);
  });
});

describe("initRepository", () => {
  it("creates a static config and never overwrites it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-init-"));
    try {
      await writeFile(path.join(root, "AGENTS.md"), "# Context\n", "utf8");
      const first = await initRepository(root), second = await initRepository(root);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await loadConfig(root)).toEqual({ context: ["AGENTS.md"], checks: { semantic: false }, ai: { provider: "openai", model: "", baseUrl: undefined } });
      expect(await readFile(path.join(root, "scavi.config.ts"), "utf8")).toContain("export default");
    } finally { await rm(root, { recursive: true, force: true }) }
  });

  it("discovers custom context files from a configured glob", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-custom-"));
    try {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "agent-context.md"), "Use pnpm.\n", "utf8");
      await writeFile(path.join(root, "scavi.config.ts"), "export default { context: [\"docs/**/*.md\"] };\n", "utf8");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.32.1" }), "utf8");
      const result = await checkRepository(root);
      expect(result.contextFiles.map((file) => file.relativePath)).toContain("docs/agent-context.md");
      expect(result.issues).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }) }
  });
});

describe("deterministic fixes", () => {
  it("previews and applies only evidence-backed minimal edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-fix-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.32.1", dependencies: { react: "^19.2.0" } }), "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "Use npm. We use React 18.\n", "utf8");
      const result = await checkRepository(root);
      const preview = await previewFixes(result);
      expect(preview).toContain("- Use npm. We use React 18.");
      expect(preview).toContain("+ Use pnpm. We use React 19.");
      expect(await applyFixes(result)).toBe(2);
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Use pnpm. We use React 19.\n");
      expect((await checkRepository(root)).issues).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }) }
  });

  it("refuses to apply a stale edit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-stale-fix-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.32.1" }), "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "Use npm.\n", "utf8");
      const result = await checkRepository(root);
      await writeFile(path.join(root, "AGENTS.md"), "Use yarn.\n", "utf8");
      await expect(applyFixes(result)).rejects.toThrow("Context changed");
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Use yarn.\n");
    } finally { await rm(root, { recursive: true, force: true }) }
  });
});

describe("semantic verification", () => {
  it("retrieves local evidence and reports a non-blocking stale verdict", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-semantic-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "AGENTS.md"), "Configuration is persisted in JSON files.\n", "utf8");
      await writeFile(path.join(root, "src", "storage.ts"), "export function saveConfiguration() { return openSqlite(); }\n", "utf8");
      await writeFile(path.join(root, "scavi.config.ts"), "export default { context: [\"AGENTS.md\"], checks: { semantic: true }, ai: { provider: \"openai\", model: \"test\" } };\n", "utf8");
      const provider: SemanticProvider = { name: "mock", async verify(request) {
        expect(request.evidence[0]?.file).toBe("src/storage.ts");
        return { verdict: "stale", confidence: 0.92, reason: "The implementation uses SQLite." };
      } };
      const result = await checkRepository(root, { semanticProvider: provider });
      expect(result.semanticFindings[0]).toMatchObject({ verdict: "stale", confidence: 0.92, provider: "mock" });
      expect(result.issues.map((issue) => issue.id)).toContain("POSSIBLY_STALE");
      expect(exitCodeFor(result)).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }) }
  });
});
