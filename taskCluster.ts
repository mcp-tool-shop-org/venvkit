// taskCluster.ts
//
// Cluster task runs by signature for aggregated visualization.
// Instead of 500 task nodes, you get one node per task signature, with:
// - run count
// - success rate
// - last run timestamp
// - dominant failure code
// - top envs it routes to
//
// Also provides flake detection: a task is flaky if it fails on some envs
// but succeeds on others (or alternates over time).

import { createHash } from "node:crypto";
import type { RunLogEventV1 } from "./runLog.js";

export type TaskSignature = {
  sigId: string; // stable hash-based id
  name: string; // task.name
  command: string; // normalized command
  requirementsKey: string; // normalized requirements fingerprint
};

export type TaskCluster = {
  sig: TaskSignature;

  runs: number;
  ok: number;
  fail: number;
  successRate: number; // 0..1
  lastAt: string;

  dominantFailure?: string; // code with most failures
  failureCounts: Record<string, number>; // code -> count

  envCounts: Record<string, number>; // pythonPath -> total run count
  envFailCounts: Record<string, number>; // pythonPath -> fail count
  envOkCounts: Record<string, number>; // pythonPath -> ok count
};

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function normCmd(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ").toLowerCase();
}

function normReq(req?: RunLogEventV1["task"]["requirements"]): string {
  if (!req) return "";
  const pkgs = (req.packages ?? [])
    .map((p) => p.toLowerCase())
    .sort()
    .join(",");
  const feats = (req.features ?? [])
    .map((f) => f.toLowerCase())
    .sort()
    .join(",");
  const tags = (req.tags ?? [])
    .map((t) => t.toLowerCase())
    .sort()
    .join(",");
  const py = (req.python ?? "").toLowerCase();
  const x64 = req.requireX64 ? "x64" : "";
  return `py=${py}|pkgs=${pkgs}|feat=${feats}|tags=${tags}|${x64}`;
}

/**
 * Extract a stable signature from a run event.
 * Runs with the same signature are clustered together.
 */
export function signatureForRun(run: RunLogEventV1): TaskSignature {
  const command = normCmd(run.task.command);
  const requirementsKey = normReq(run.task.requirements);
  const base = `${run.task.name}|${command}|${requirementsKey}`;
  const sigId = `task_${sha16(base)}`;
  return { sigId, name: run.task.name, command, requirementsKey };
}

/**
 * Cluster runs by task signature.
 * Returns clusters sorted by run count (descending).
 */
export function clusterRuns(runs: RunLogEventV1[]): TaskCluster[] {
  const map = new Map<string, TaskCluster>();

  for (const r of runs) {
    const sig = signatureForRun(r);
    const key = sig.sigId;

    let c = map.get(key);
    if (!c) {
      c = {
        sig,
        runs: 0,
        ok: 0,
        fail: 0,
        successRate: 0,
        lastAt: r.at,
        failureCounts: {},
        envCounts: {},
        envFailCounts: {},
        envOkCounts: {},
      };
      map.set(key, c);
    }

    c.runs += 1;
    if (r.outcome.ok) c.ok += 1;
    else c.fail += 1;

    if (r.at > c.lastAt) c.lastAt = r.at;

    const py = r.selected.pythonPath;
    c.envCounts[py] = (c.envCounts[py] ?? 0) + 1;

    if (r.outcome.ok) {
      c.envOkCounts[py] = (c.envOkCounts[py] ?? 0) + 1;
    } else {
      const code = r.doctor?.dominantIssue ?? r.outcome.errorClass ?? "RUN_FAILED";
      c.failureCounts[code] = (c.failureCounts[code] ?? 0) + 1;
      c.envFailCounts[py] = (c.envFailCounts[py] ?? 0) + 1;
    }
  }

  // Compute derived fields
  for (const c of map.values()) {
    c.successRate = c.runs ? c.ok / c.runs : 0;

    // Find dominant failure code
    let best: { code: string; count: number } | null = null;
    for (const [code, count] of Object.entries(c.failureCounts)) {
      if (!best || count > best.count) best = { code, count };
    }
    if (best) c.dominantFailure = best.code;
  }

  return [...map.values()].sort((a, b) => b.runs - a.runs);
}

/**
 * Determine if a task cluster is flaky.
 * Flaky = both succeeds and fails, with success rate not extreme.
 */
export function isFlaky(cluster: TaskCluster): boolean {
  // Needs both successes and failures
  if (cluster.ok === 0 || cluster.fail === 0) return false;
  // Success rate between 20% and 95% indicates inconsistent behavior
  return cluster.successRate > 0.2 && cluster.successRate < 0.95;
}

/**
 * Determine if a task cluster is env-dependent flaky.
 * This means it succeeds on some envs and fails on others.
 */
export function isEnvDependentFlaky(cluster: TaskCluster): boolean {
  const envs = Object.keys(cluster.envCounts);
  if (envs.length < 2) return false;

  let hasSuccessEnv = false;
  let hasFailEnv = false;

  for (const py of envs) {
    const ok = cluster.envOkCounts[py] ?? 0;
    const fail = cluster.envFailCounts[py] ?? 0;
    if (ok > 0 && fail === 0) hasSuccessEnv = true;
    if (fail > 0 && ok === 0) hasFailEnv = true;
  }

  return hasSuccessEnv && hasFailEnv;
}

/**
 * Get the envs where this task fails most.
 */
export function getFailingEnvs(
  cluster: TaskCluster,
  limit = 3
): Array<{ pythonPath: string; failCount: number; totalCount: number; failRate: number }> {
  return Object.entries(cluster.envFailCounts)
    .map(([py, failCount]) => ({
      pythonPath: py,
      failCount,
      totalCount: cluster.envCounts[py] ?? failCount,
      failRate: failCount / (cluster.envCounts[py] ?? failCount),
    }))
    .sort((a, b) => b.failCount - a.failCount)
    .slice(0, limit);
}

/**
 * Get summary statistics for a set of clusters.
 */
export function summarizeClusters(clusters: TaskCluster[]): {
  totalTasks: number;
  totalRuns: number;
  totalOk: number;
  totalFail: number;
  overallSuccessRate: number;
  flakyCount: number;
  envDependentFlakyCount: number;
} {
  let totalRuns = 0;
  let totalOk = 0;
  let totalFail = 0;
  let flakyCount = 0;
  let envDependentFlakyCount = 0;

  for (const c of clusters) {
    totalRuns += c.runs;
    totalOk += c.ok;
    totalFail += c.fail;
    if (isFlaky(c)) flakyCount++;
    if (isEnvDependentFlaky(c)) envDependentFlakyCount++;
  }

  return {
    totalTasks: clusters.length,
    totalRuns,
    totalOk,
    totalFail,
    overallSuccessRate: totalRuns ? totalOk / totalRuns : 0,
    flakyCount,
    envDependentFlakyCount,
  };
}
