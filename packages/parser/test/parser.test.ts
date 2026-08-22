import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { discoverContextFiles, parseContextFile } from "../src/index.js";

describe("parseContextFile", () => {
  it("extracts deterministic candidates from inline code", () => {
    const parsed = parseContextFile({ absolutePath: "/repo/AGENTS.md", relativePath: "AGENTS.md", content: "Use pnpm. Run `pnpm test` in `apps/web`. We use React 18." });
    expect(parsed.commands[0]).toMatchObject({ manager: "pnpm", script: "test" });
    expect(parsed.paths[0]?.value).toBe("apps/web");
    expect(parsed.packageManagers.map((claim) => claim.manager)).toContain("pnpm");
    expect(parsed.dependencies[0]).toMatchObject({ package: "react", version: "18" });
  });

  it("ignores URLs, package names, and wildcard examples", () => {
    const parsed = parseContextFile({ absolutePath: "/repo/AGENTS.md", relativePath: "AGENTS.md", content: "See `https://example.com`, `@scavi/core`, and `.cursor/rules/*.mdc`." });
    expect(parsed.paths).toEqual([]);
  });

  it("extracts conservative semantic claims but ignores fenced examples", () => {
    const parsed = parseContextFile({ absolutePath: "/repo/AGENTS.md", relativePath: "AGENTS.md", content: "Configuration is persisted in SQLite storage.\n```md\nConfiguration is persisted in JSON files.\n```" });
    expect(parsed.semanticClaims.map((claim) => claim.text)).toEqual(["Configuration is persisted in SQLite storage."]);
  });

  it("recognizes manager builtins, explicit scripts, and fenced commands", () => {
    const parsed = parseContextFile({ absolutePath: "/repo/AGENTS.md", relativePath: "AGENTS.md", content: "`npm ci`\n`npm run install`\n`npm test`\n```sh\npnpm test\n```" });
    expect(parsed.commands.map((claim) => ({ manager: claim.manager, script: claim.script }))).toEqual([
      { manager: "npm", script: undefined },
      { manager: "npm", script: "install" },
      { manager: "npm", script: "test" },
      { manager: "pnpm", script: "test" },
    ]);
  });
});

describe("discoverContextFiles", () => {
  it("does not read configured context through a link outside the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scavi-context-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "scavi-context-outside-"));
    try {
      await writeFile(path.join(outside, "AGENTS.md"), "host secret", "utf8");
      await symlink(outside, path.join(root, "linked"), "junction");
      expect(await discoverContextFiles(root, ["linked/AGENTS.md"])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
