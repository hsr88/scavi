import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export interface SourceLocation { file: string; line: number; column?: number }
export interface ContextFile { absolutePath: string; relativePath: string; content: string }
export interface PathClaim { type: "path"; value: string; source: SourceLocation; text: string }
export interface CommandClaim { type: "command"; value: string; manager: PackageManager; script?: string; source: SourceLocation; text: string }
export interface PackageManagerClaim { type: "package-manager"; manager: PackageManager; source: SourceLocation; text: string }
export interface DependencyClaim { type: "dependency-version"; package: string; version: string; source: SourceLocation; text: string }
export interface SemanticClaim { type: "semantic"; text: string; source: SourceLocation }
export interface ParsedContext { file: ContextFile; paths: PathClaim[]; commands: CommandClaim[]; packageManagers: PackageManagerClaim[]; dependencies: DependencyClaim[]; semanticClaims: SemanticClaim[] }

const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const MANAGERS: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

async function cursorRules(root: string): Promise<string[]> {
  const directory = path.join(root, ".cursor", "rules");
  try {
    const entries = await readdir(directory, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mdc")).map((entry) => path.join(entry.parentPath, entry.name));
  } catch { return []; }
}

function globRegex(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.slice(index, index + 3) === "**/") { expression += "(?:.*/)?"; index += 2 }
    else if (pattern.slice(index, index + 2) === "**") { expression += ".*"; index += 1 }
    else if (pattern[index] === "*") expression += "[^/]*";
    else expression += pattern[index].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

async function customFiles(root: string, patterns: string[]): Promise<string[]> {
  const safePatterns = patterns.map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "")).filter((item) => item && !path.isAbsolute(item) && !item.split("/").includes(".."));
  if (!safePatterns.some((item) => item.includes("*"))) return safePatterns.map((item) => path.join(root, item));
  const matches: string[] = safePatterns.filter((item) => !item.includes("*")).map((item) => path.join(root, item));
  const regexes = safePatterns.filter((item) => item.includes("*")).map(globRegex);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.split("/").some((part) => [".git", "node_modules", "dist", ".scavi"].includes(part))) continue;
    if (regexes.some((regex) => regex.test(relative))) matches.push(absolute);
  }
  return matches;
}

export async function discoverContextFiles(root: string, custom: string[] = []): Promise<ContextFile[]> {
  const candidates = [...ROOT_FILES.map((file) => path.join(root, file)), path.join(root, ".github", "copilot-instructions.md"), ...(await cursorRules(root)), ...(await customFiles(root, custom))];
  const result: ContextFile[] = [];
  for (const absolutePath of [...new Set(candidates)]) {
    try {
      result.push({ absolutePath, relativePath: path.relative(root, absolutePath).split(path.sep).join("/"), content: await readFile(absolutePath, "utf8") });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isPath(value: string): boolean {
  if (!value || /^(?:https?:|git@|[\w-]+@\d)/i.test(value) || /\s/.test(value) || /[*{}<>|]/.test(value)) return false;
  if (/^(?:npm|pnpm|yarn|bun|node|npx)(?:$|\s)/.test(value)) return false;
  if (/^@[\w.-]+\/[\w.-]+$/.test(value)) return false;
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[\w.-]+\/[\w./-]+$/.test(value) || /^\.?[\w-]+\.[a-z0-9]{1,8}$/i.test(value);
}

function command(value: string): Omit<CommandClaim, "source" | "text"> | undefined {
  const match = value.trim().match(/^(npm|pnpm|yarn|bun)\s+(?:(?:run)\s+)?([\w:@./-]+)(?:\s+.*)?$/);
  if (!match) return;
  const manager = match[1] as PackageManager;
  const token = match[2];
  const builtins = new Set(["install", "add", "remove", "exec", "dlx", "init", "create", "publish", "pack"]);
  return { type: "command", value: value.trim(), manager, script: builtins.has(token) ? undefined : token };
}

export function parseContextFile(file: ContextFile): ParsedContext {
  const paths: PathClaim[] = [], commands: CommandClaim[] = [], packageManagers: PackageManagerClaim[] = [], dependencies: DependencyClaim[] = [], semanticClaims: SemanticClaim[] = [];
  let inFence = false;
  file.content.split(/\r?\n/).forEach((line, index) => {
    const source = { file: file.relativePath, line: index + 1 };
    if (/^\s*```/.test(line)) { inFence = !inFence; return }
    if (inFence) return;
    const pathCount = paths.length, commandCount = commands.length, dependencyCount = dependencies.length;
    for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
      const value = match[1].trim().replace(/[.,;:]$/, "");
      const parsed = command(value);
      const claimSource = { ...source, column: (match.index ?? 0) + 2 };
      if (parsed) commands.push({ ...parsed, source: claimSource, text: line.trim() });
      else if (isPath(value)) paths.push({ type: "path", value, source: claimSource, text: line.trim() });
    }
    for (const manager of MANAGERS) {
      const explicit = new RegExp(`\\b(?:use|using|uses|with|prefer|package manager(?: is|:)?)[ \\t]+${manager}\\b`, "i");
      const explicitMatch = explicit.exec(line);
      const commandEvidence = commands.find((claim) => claim.source.line === index + 1 && claim.manager === manager);
      if (explicitMatch || commandEvidence) {
        const column = explicitMatch
          ? explicitMatch.index + explicitMatch[0].toLowerCase().lastIndexOf(manager) + 1
          : commandEvidence?.source.column;
        packageManagers.push({ type: "package-manager", manager, source: { ...source, column }, text: line.trim() });
      }
    }
    const dependency = line.match(/\b(?:we (?:use|are using)|built with|uses?|requires?)\s+(@?[a-z0-9][\w./-]*)\s+(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){0,2})\b/i);
    if (dependency) {
      const start = (dependency.index ?? 0) + dependency[0].lastIndexOf(dependency[2]);
      dependencies.push({ type: "dependency-version", package: dependency[1].toLowerCase(), version: dependency[2], source: { ...source, column: start + 1 }, text: line.trim() });
    }
    const deterministicOnLine = paths.length > pathCount || commands.length > commandCount || dependencies.length > dependencyCount;
    const semanticPattern = /\b(?:configuration|settings|authentication|authorization|data|state|storage|frontend|backend|api|database|application|app|service|users?|requests?)\b.*\b(?:is|are|stores?|stored|persists?|persisted|uses?|writes?|reads?|flows?|runs?)\b/i;
    const text = line.trim().replace(/^[-*>]\s*/, "");
    if (!deterministicOnLine && text.length >= 20 && text.length <= 500 && !text.startsWith("#") && semanticPattern.test(text)) semanticClaims.push({ type: "semantic", text, source });
  });
  return { file, paths, commands, packageManagers, dependencies, semanticClaims };
}

export function parseContextFiles(files: ContextFile[]): ParsedContext[] { return files.map(parseContextFile) }
