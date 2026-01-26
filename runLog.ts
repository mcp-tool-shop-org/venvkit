// runLog.ts
//
// Append-only JSONL run log for tracking task executions against Python envs.
// Each line is one RunLogEventV1 — durable, streaming-friendly, keeps forever.
//
// Used by mapRender to create:
// - task nodes (one per run)
// - ROUTES_TASK_TO edges (task → env)
// - FAILED_RUN edges (task → env with dominant issue label)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type RunLogEventV1 = {
  version: "1.0";
  runId: string; // stable id for this run (uuid or sha)
  at: string; // ISO8601
  cwd?: string;

  task: {
    name: string; // "pytest", "lint", "train", "scrape"
    command: string; // full command string
    args?: string[];
    requirements?: {
      python?: string;
      packages?: string[];
      features?: string[];
      tags?: string[];
      requireX64?: boolean;
    };
  };

  selected: {
    pythonPath: string; // env python used
    envId?: string; // optional stable id if you already computed one
    score?: number; // doctor score at selection time
    status?: "good" | "warn" | "bad" | "unknown";
  };

  outcome: {
    ok: boolean;
    exitCode?: number | null;
    durationMs?: number;
    errorClass?: string; // e.g. "DLL_LOAD_FAIL", "SSL_BROKEN", "PIP_CHECK_FAIL", "RUNTIME_ERROR"
    stderrSnippet?: string;
  };

  doctor?: {
    dominantIssue?: string; // same codes as Finding.code
    findings?: string[]; // list of finding codes (optional)
  };
};

export type RunLogReadOptions = {
  maxLines?: number; // read last N lines (default 5000)
};

/**
 * Generate a run ID.
 * @param input Optional deterministic seed (task signature). If omitted, returns UUID.
 */
export function newRunId(input?: string): string {
  if (!input) return randomUUID();
  // deterministic id from task signature if desired
  const h = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `run_${h}`;
}

/**
 * Append a run event to the JSONL log file.
 * Creates parent directories if needed.
 */
export async function appendRunLog(logPath: string, evt: RunLogEventV1): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const line = JSON.stringify(evt) + "\n";
  await fs.appendFile(logPath, line, "utf8");
}

/**
 * Read run events from a JSONL log file.
 * Returns the last `maxLines` events (default 5000).
 * Skips malformed lines gracefully.
 */
export async function readRunLog(logPath: string, opts: RunLogReadOptions = {}): Promise<RunLogEventV1[]> {
  const maxLines = opts.maxLines ?? 5000;

  let raw = "";
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.trimEnd().split("\n");
  const tail = lines.slice(Math.max(0, lines.length - maxLines));

  const out: RunLogEventV1[] = [];
  for (const l of tail) {
    if (!l.trim()) continue;
    try {
      const obj = JSON.parse(l);
      if (obj?.version === "1.0") out.push(obj as RunLogEventV1);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

/**
 * Count runs by outcome status.
 */
export function summarizeRuns(runs: RunLogEventV1[]): {
  total: number;
  passed: number;
  failed: number;
  byTask: Map<string, { passed: number; failed: number }>;
  byEnv: Map<string, { passed: number; failed: number }>;
} {
  const byTask = new Map<string, { passed: number; failed: number }>();
  const byEnv = new Map<string, { passed: number; failed: number }>();

  let passed = 0;
  let failed = 0;

  for (const run of runs) {
    if (run.outcome.ok) {
      passed++;
    } else {
      failed++;
    }

    // By task name
    const taskName = run.task.name;
    const taskStats = byTask.get(taskName) ?? { passed: 0, failed: 0 };
    if (run.outcome.ok) taskStats.passed++;
    else taskStats.failed++;
    byTask.set(taskName, taskStats);

    // By env path
    const envPath = run.selected.pythonPath;
    const envStats = byEnv.get(envPath) ?? { passed: 0, failed: 0 };
    if (run.outcome.ok) envStats.passed++;
    else envStats.failed++;
    byEnv.set(envPath, envStats);
  }

  return { total: runs.length, passed, failed, byTask, byEnv };
}
