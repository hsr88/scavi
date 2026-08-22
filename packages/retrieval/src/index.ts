import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface RepositoryChunk { file: string; startLine: number; endLine: number; content: string }
export interface RankedEvidence extends RepositoryChunk { score: number }
export interface RetrievalOptions { excludeFiles?: string[]; maxFiles?: number; maxFileBytes?: number; chunkLines?: number; overlapLines?: number }

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".scavi"]);
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdc", ".yaml", ".yml", ".toml", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".sql", ".graphql", ".sh", ".ps1"]);
const TEXT_FILENAMES = new Set(["Dockerfile", "Makefile", "Taskfile", ".env.example"]);
const STOP_WORDS = new Set(["the", "and", "that", "this", "with", "from", "into", "uses", "use", "are", "is", "stored", "persisted"]);

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).filter((token) => !STOP_WORDS.has(token)))];
}

export async function indexRepository(root: string, options: RetrievalOptions = {}): Promise<RepositoryChunk[]> {
  const exclude = new Set((options.excludeFiles ?? []).map((file) => file.replace(/\\/g, "/")));
  const maxFiles = options.maxFiles ?? 2_000, maxBytes = options.maxFileBytes ?? 256_000, chunkLines = options.chunkLines ?? 40, overlap = options.overlapLines ?? 8;
  async function walk(directory: string): Promise<string[]> {
    const discovered: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!relative.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part))) discovered.push(...await walk(absolute));
      } else if (entry.isFile()) discovered.push(absolute);
    }
    return discovered;
  }
  const files: string[] = [];
  for (const absolute of (await walk(root)).sort()) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part)) || exclude.has(relative)) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase()) && !TEXT_FILENAMES.has(path.basename(absolute))) continue;
    if ((await stat(absolute)).size <= maxBytes) files.push(absolute);
  }
  const chunks: RepositoryChunk[] = [];
  for (const absolute of files.slice(0, maxFiles)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/"), lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
    const step = Math.max(1, chunkLines - overlap);
    for (let start = 0; start < lines.length; start += step) {
      const selected = lines.slice(start, start + chunkLines);
      if (selected.join("").trim()) chunks.push({ file: relative, startLine: start + 1, endLine: start + selected.length, content: selected.join("\n") });
      if (start + chunkLines >= lines.length) break;
    }
  }
  return chunks;
}

export function retrieveEvidence(claim: string, chunks: RepositoryChunk[], limit = 5): RankedEvidence[] {
  const query = tokens(claim);
  if (query.length === 0) return [];
  return chunks.map((chunk) => {
    const content = chunk.content.toLowerCase(), file = chunk.file.toLowerCase();
    let score = 0;
    for (const token of query) {
      const occurrences = content.split(token).length - 1;
      score += Math.min(occurrences, 5);
      if (file.includes(token)) score += 3;
    }
    return { ...chunk, score };
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
}
