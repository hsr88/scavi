import { describe, expect, it } from "vitest";
import { parseContextFile } from "../src/index.js";

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
