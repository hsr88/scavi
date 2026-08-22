import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PackageManager, ParsedContext, SourceLocation } from "@scavi/parser";

export type Severity = "info" | "warning" | "error";
export interface Evidence { description: string; file?: string }
export interface ScaviEdit { file: string; start: number; end: number; replacement: string; expected: string }
export interface ScaviFix { description: string; edits: ScaviEdit[]; generatedBy: "deterministic" | "ai"; confidence?: number }
export interface ScaviIssue { id: string; rule: string; severity: Severity; source: SourceLocation; message: string; claim?: string; evidence: Evidence[]; confidence?: number; fix?: ScaviFix }
export interface RepositoryFacts { root: string; packageManager?: PackageManager; packageManagerEvidence: Evidence[]; scripts: Set<string>; dependencies: Record<string, string> }
const LOCKFILES: Array<[string, PackageManager]> = [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]];
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true } catch { return false } }

export async function collectRepositoryFacts(root: string): Promise<RepositoryFacts> {
  const evidence: Evidence[] = [], detected = new Set<PackageManager>(), scripts = new Set<string>(), dependencies: Record<string, string> = {};
  let manifestManager: PackageManager | undefined;
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { packageManager?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; engines?: { node?: string } };
    Object.keys(manifest.scripts ?? {}).forEach((script) => scripts.add(script));
    Object.assign(dependencies, manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies);
    if (manifest.engines?.node) dependencies.node = manifest.engines.node;
    const match = manifest.packageManager?.match(/^(npm|pnpm|yarn|bun)@/);
    if (match) { manifestManager = match[1] as PackageManager; detected.add(manifestManager); evidence.push({ file: "package.json", description: `packageManager: ${manifest.packageManager}` }) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid package.json", { cause: error }) }
  for (const [lockfile, manager] of LOCKFILES) if (await exists(path.join(root, lockfile))) { detected.add(manager); evidence.push({ file: lockfile, description: `${lockfile} exists` }) }
  return { root, packageManager: detected.size === 1 ? [...detected][0] : manifestManager, packageManagerEvidence: evidence, scripts, dependencies };
}

function resolveClaimPath(root: string, value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized.includes("/../")) return;
  const candidate = path.resolve(root, normalized.replace(/^\.\//, "").replace(/^\//, ""));
  const relation = path.relative(root, candidate);
  return relation.startsWith("..") || path.isAbsolute(relation) ? undefined : candidate;
}
async function presentInside(root: string, candidate: string): Promise<boolean> {
  try { const relation = path.relative(await realpath(root), await realpath(candidate)); return !relation.startsWith("..") && !path.isAbsolute(relation) } catch { return false }
}

function sourceOffset(content: string, source: SourceLocation): number | undefined {
  if (!source.column || source.line < 1 || source.column < 1) return;
  let line = 1, lineStart = 0;
  for (let index = 0; index < content.length && line < source.line; index += 1) {
    if (content[index] === "\n") { line += 1; lineStart = index + 1 }
  }
  return line === source.line ? lineStart + source.column - 1 : undefined;
}

export async function runDeterministicRules(contexts: ParsedContext[], facts: RepositoryFacts): Promise<ScaviIssue[]> {
  const issues: ScaviIssue[] = [];
  for (const context of contexts) {
    for (const claim of context.paths) {
      const candidate = resolveClaimPath(facts.root, claim.value);
      if (!candidate || !(await presentInside(facts.root, candidate))) {
        const basename = path.posix.basename(claim.value);
        const fileLike = basename.startsWith(".") || path.posix.extname(basename) !== "";
        issues.push({ id: fileLike ? "MISSING_REFERENCED_FILE" : "STALE_PATH", rule: fileLike ? "referenced-file" : "valid-path", severity: "error", source: claim.source, message: `${fileLike ? "Referenced file" : "Referenced path"} does not exist: ${claim.value}`, claim: claim.text, evidence: [{ description: candidate ? `${claim.value} was not found inside the repository` : `${claim.value} escapes the repository root` }] });
      }
    }
    for (const claim of context.commands) {
      if (claim.script && !facts.scripts.has(claim.script)) issues.push({ id: "INVALID_COMMAND", rule: "valid-command", severity: "error", source: claim.source, message: `Package script was not found: ${claim.script}`, claim: claim.value, evidence: [{ file: "package.json", description: `scripts does not define ${claim.script}` }] });
    }
    for (const claim of context.packageManagers) if (facts.packageManager && claim.manager !== facts.packageManager) {
      const start = sourceOffset(context.file.content, claim.source);
      issues.push({ id: "PACKAGE_MANAGER_MISMATCH", rule: "package-manager", severity: "error", source: claim.source, message: `Instruction names ${claim.manager}, but the repository uses ${facts.packageManager}`, claim: claim.text, evidence: facts.packageManagerEvidence,
        fix: start === undefined ? undefined : { description: `Replace ${claim.manager} with ${facts.packageManager}`, generatedBy: "deterministic", edits: [{ file: claim.source.file, start, end: start + claim.manager.length, replacement: facts.packageManager, expected: claim.manager }] } });
    }
    for (const claim of context.dependencies) {
      const declared = facts.dependencies[claim.package];
      if (!declared) continue;
      const actual = declared.match(/\d+(?:\.\d+){0,2}/)?.[0];
      const claimedMajor = claim.version.split(".")[0], actualMajor = actual?.split(".")[0];
      if (actualMajor && claimedMajor !== actualMajor) {
        const start = sourceOffset(context.file.content, claim.source);
        const replacement = actual?.split(".").slice(0, claim.version.split(".").length).join(".") ?? actualMajor;
        issues.push({ id: "DEPENDENCY_VERSION_MISMATCH", rule: "dependency-version", severity: "error", source: claim.source, message: `${claim.package} ${claim.version} does not match declared version ${declared}`, claim: claim.text, evidence: [{ file: "package.json", description: `${claim.package}: ${declared}` }],
          fix: start === undefined ? undefined : { description: `Update ${claim.package} version claim to ${replacement}`, generatedBy: "deterministic", edits: [{ file: claim.source.file, start, end: start + claim.version.length, replacement, expected: claim.version }] } });
      }
    }
  }
  const managers = new Map<PackageManager, SourceLocation[]>();
  for (const claim of contexts.flatMap((item) => item.packageManagers)) managers.set(claim.manager, [...(managers.get(claim.manager) ?? []), claim.source]);
  if (managers.size > 1) {
    const first = contexts.flatMap((item) => item.packageManagers)[0];
    issues.push({ id: "CONTEXT_CONFLICT", rule: "context-conflict", severity: "warning", source: first.source, message: `Conflicting package managers: ${[...managers.keys()].join(", ")}`, evidence: [...managers].map(([manager, locations]) => ({ description: `${manager}: ${locations.map((item) => `${item.file}:${item.line}`).join(", ")}` })) });
  }
  const unique = new Map<string, ScaviIssue>();
  issues.forEach((issue) => unique.set(`${issue.id}:${issue.source.file}:${issue.source.line}:${issue.message}`, issue));
  return [...unique.values()].sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line);
}
