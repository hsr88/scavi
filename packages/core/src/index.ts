import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { OllamaProvider, OpenAIResponsesProvider, type SemanticProvider, type SemanticVerdict } from "@scavi/ai";
import { discoverContextFiles, parseContextFiles, type ContextFile, type SourceLocation } from "@scavi/parser";
import { indexRepository, retrieveEvidence, type RankedEvidence } from "@scavi/retrieval";
import { collectRepositoryFacts, runDeterministicRules, type RepositoryFacts, type ScaviEdit, type ScaviIssue } from "@scavi/rules";

export interface SemanticFinding { source: SourceLocation; claim: string; verdict: SemanticVerdict; confidence: number; evidence: RankedEvidence[]; reason: string; provider?: string }
export interface CheckResult { root: string; contextFiles: ContextFile[]; facts: RepositoryFacts; issues: ScaviIssue[]; semanticFindings: SemanticFinding[]; summary: { errors: number; warnings: number; infos: number; total: number } }
export interface ScaviConfig { context?: string[]; checks?: { semantic?: boolean }; ai?: { provider?: "openai" | "ollama"; model?: string; baseUrl?: string } }
export interface CheckOptions { semanticProvider?: SemanticProvider }
export interface InitResult { root: string; configPath: string; created: boolean; contextFiles: string[]; packageManager?: string }

async function isDirectory(candidate: string): Promise<boolean> { try { return (await stat(candidate)).isDirectory() } catch { return false } }
async function exists(candidate: string): Promise<boolean> { try { await stat(candidate); return true } catch { return false } }

export async function findRepositoryRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  if (!(await isDirectory(current))) throw new Error(`Repository path is not a directory: ${start}`);
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function defineConfig(config: ScaviConfig): ScaviConfig { return config }

export async function loadConfig(root: string): Promise<ScaviConfig> {
  const configPath = path.join(root, "scavi.config.ts");
  let source: string;
  try { source = await readFile(configPath, "utf8") }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error }
  const contextBlock = source.match(/\bcontext\s*:\s*\[([\s\S]*?)\]/)?.[1];
  const context = contextBlock ? [...contextBlock.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]) : undefined;
  const checksBlock = source.match(/\bchecks\s*:\s*\{([\s\S]*?)\}/)?.[1];
  const semantic = checksBlock?.match(/\bsemantic\s*:\s*(true|false)/)?.[1];
  const aiBlock = source.match(/\bai\s*:\s*\{([\s\S]*?)\}/)?.[1];
  const stringValue = (name: string) => aiBlock?.match(new RegExp(`\\b${name}\\s*:\\s*["']([^"']*)["']`))?.[1];
  const provider = stringValue("provider");
  return { context, checks: semantic ? { semantic: semantic === "true" } : undefined, ai: aiBlock ? { provider: provider === "openai" || provider === "ollama" ? provider : undefined, model: stringValue("model"), baseUrl: stringValue("baseUrl") } : undefined };
}

export async function initRepository(start?: string): Promise<InitResult> {
  const root = start ? path.resolve(start) : await findRepositoryRoot();
  if (!(await isDirectory(root))) throw new Error(`Repository path is not a directory: ${start}`);
  const facts = await collectRepositoryFacts(root);
  const discovered = await discoverContextFiles(root);
  const context = discovered.map((file) => file.relativePath);
  const configPath = path.join(root, "scavi.config.ts");
  const values = (context.length ? context : ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursor/rules/**/*.mdc"])
    .map((item) => `    ${JSON.stringify(item)},`).join("\n");
  const source = `export default {\n  context: [\n${values}\n  ],\n  checks: {\n    semantic: false,\n  },\n  ai: {\n    provider: "openai",\n    model: "",\n  },\n};\n`;
  let created = true;
  try { await writeFile(configPath, source, { encoding: "utf8", flag: "wx" }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") created = false; else throw error }
  return { root, configPath, created, contextFiles: context, packageManager: facts.packageManager };
}

export function configuredModel(config: ScaviConfig): string { return config.ai?.model || process.env.SCAVI_AI_MODEL || "" }

function configuredProvider(config: ScaviConfig): SemanticProvider {
  const model = configuredModel(config);
  if (config.ai?.provider === "openai") return new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY ?? "", model, baseUrl: config.ai.baseUrl ?? process.env.OPENAI_BASE_URL });
  if (config.ai?.provider === "ollama") return new OllamaProvider({ model, baseUrl: config.ai.baseUrl ?? process.env.OLLAMA_HOST });
  throw new Error("Semantic analysis requires ai.provider: \"openai\" or \"ollama\"");
}

export async function checkRepository(start?: string, options: CheckOptions = {}): Promise<CheckResult> {
  const root = start ? path.resolve(start) : await findRepositoryRoot();
  if (!(await isDirectory(root))) throw new Error(`Repository path is not a directory: ${start}`);
  const config = await loadConfig(root);
  const contextFiles = await discoverContextFiles(root, config.context);
  const facts = await collectRepositoryFacts(root);
  const parsed = parseContextFiles(contextFiles);
  const issues = await runDeterministicRules(parsed, facts);
  const semanticFindings: SemanticFinding[] = [];
  if (config.checks?.semantic) {
    const provider = options.semanticProvider ?? configuredProvider(config);
    const chunks = await indexRepository(root, { excludeFiles: contextFiles.map((file) => file.relativePath) });
    for (const claim of parsed.flatMap((context) => context.semanticClaims)) {
      const evidence = retrieveEvidence(claim.text, chunks);
      if (evidence.length === 0) {
        semanticFindings.push({ source: claim.source, claim: claim.text, verdict: "uncertain", confidence: 0, evidence: [], reason: "No relevant repository evidence was retrieved." });
        continue;
      }
      const result = await provider.verify({ claim: claim.text, evidence });
      semanticFindings.push({ source: claim.source, claim: claim.text, evidence, provider: provider.name, ...result });
      if (result.verdict === "stale") issues.push({ id: "POSSIBLY_STALE", rule: "semantic-verification", severity: "warning", source: claim.source, message: result.reason, claim: claim.text, confidence: result.confidence, evidence: evidence.map((item) => ({ file: item.file, description: `lines ${item.startLine}-${item.endLine}, retrieval score ${item.score}` })) });
    }
  }
  return {
    root, contextFiles, facts, issues, semanticFindings,
    summary: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      infos: issues.filter((issue) => issue.severity === "info").length,
      total: issues.length,
    },
  };
}

export function exitCodeFor(result: CheckResult): 0 | 1 { return result.summary.errors > 0 ? 1 : 0 }

function fixEdits(result: CheckResult): ScaviEdit[] {
  const unique = new Map<string, ScaviEdit>();
  for (const edit of result.issues.flatMap((issue) => issue.fix?.edits ?? [])) unique.set(`${edit.file}:${edit.start}:${edit.end}:${edit.replacement}`, edit);
  return [...unique.values()];
}

function applyToContent(content: string, edits: ScaviEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let index = 0; index < sorted.length; index += 1) {
    const edit = sorted[index];
    const next = sorted[index + 1];
    if (next && next.end > edit.start) throw new Error(`Overlapping fixes in ${edit.file}`);
    if (content.slice(edit.start, edit.end) !== edit.expected) throw new Error(`Context changed before fix could be applied: ${edit.file}`);
    content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
  }
  return content;
}

export async function previewFixes(result: CheckResult): Promise<string> {
  const edits = fixEdits(result), groups = new Map<string, ScaviEdit[]>();
  for (const edit of edits) groups.set(edit.file, [...(groups.get(edit.file) ?? []), edit]);
  const output: string[] = [];
  for (const [file, fileEdits] of groups) {
    const original = await readFile(path.join(result.root, file), "utf8");
    const modified = applyToContent(original, fileEdits);
    const before = original.split(/\r?\n/), after = modified.split(/\r?\n/);
    output.push(file);
    for (let line = 0; line < Math.max(before.length, after.length); line += 1) {
      if (before[line] !== after[line]) output.push(`@@ line ${line + 1} @@`, `- ${before[line] ?? ""}`, `+ ${after[line] ?? ""}`);
    }
  }
  return output.join("\n");
}

export async function applyFixes(result: CheckResult): Promise<number> {
  const edits = fixEdits(result), groups = new Map<string, ScaviEdit[]>();
  for (const edit of edits) groups.set(edit.file, [...(groups.get(edit.file) ?? []), edit]);
  const prepared: Array<{ fileReal: string; modified: string; editCount: number }> = [];
  const rootReal = await realpath(result.root);
  for (const [file, fileEdits] of groups) {
    const absolute = path.resolve(result.root, file);
    const fileReal = await realpath(absolute);
    const relation = path.relative(rootReal, fileReal);
    if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Fix target escapes repository root: ${file}`);
    const original = await readFile(fileReal, "utf8");
    const modified = applyToContent(original, fileEdits);
    prepared.push({ fileReal, modified, editCount: fileEdits.length });
  }
  let applied = 0;
  for (const { fileReal, modified, editCount } of prepared) {
    const temporary = path.join(path.dirname(fileReal), `.scavi-fix-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    try { await writeFile(temporary, modified, { encoding: "utf8", flag: "wx" }); await rename(temporary, fileReal) }
    finally { try { await unlink(temporary) } catch { /* already renamed */ } }
    applied += editCount;
  }
  return applied;
}
