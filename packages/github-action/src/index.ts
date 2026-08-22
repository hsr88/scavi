import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRepository } from "@scavi/core";
import { buildMarkdownReport } from "./report.js";

const execFileAsync = promisify(execFile);

async function changedFiles(root: string, base: string): Promise<string[]> {
  if (!base) return [];
  if (base.startsWith("-") || !/^[A-Za-z0-9_./-]+$/.test(base)) throw new Error("diff-base contains unsupported characters");
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--"], { cwd: root, encoding: "utf8", maxBuffer: 2_000_000 });
  return stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
}

export async function runAction(): Promise<void> {
  try {
    const root = core.getInput("repository-path") || ".";
    const base = core.getInput("diff-base");
    const changes = await changedFiles(root, base);
    const result = await checkRepository(root);
    const report = buildMarkdownReport(result, changes);
    await core.summary.addRaw(report).write();
    core.setOutput("issue-count", result.summary.total);
    core.setOutput("error-count", result.summary.errors);
    core.setOutput("changed-files", JSON.stringify(changes));
    core.info(report);
    if (core.getBooleanInput("fail-on-deterministic") && result.summary.errors > 0) core.setFailed(`Scavi found ${result.summary.errors} deterministic ${result.summary.errors === 1 ? "error" : "errors"}.`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void runAction();
