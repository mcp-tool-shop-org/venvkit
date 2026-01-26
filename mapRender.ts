// mapRender.ts
//
// Build a "venv ecosystem map" from DoctorLite reports.
// Outputs:
//  - Canonical Graph JSON (v1)
//  - Mermaid diagram (derived)
//  - Insights (what's broken + blast radius + cleanup plan)
//
// "Special" bits:
//  1) Blast-radius analysis: detects base interpreters that infect many envs (shared issues).
//  2) Shadow/leak detection: calls out PYTHONPATH + user-site leakage as ecosystem-level problems.
//  3) Mermaid subgraphs per base interpreter + severity styling + "hot edge" labels for dominant issues.
//  4) Deterministic node IDs via sha256 so maps are stable across runs.

import * as os from "node:os";
import { createHash } from "node:crypto";

import type { DoctorLiteReport, Finding } from "./doctorLite.js";
import type { RunLogEventV1 } from "./runLog.js";
import { clusterRuns, isFlaky, isEnvDependentFlaky, getFailingEnvs, type TaskCluster } from "./taskCluster.js";

export type GraphHealthStatus = "good" | "warn" | "bad" | "unknown";

export type GraphIssue = {
  code: string;
  severity: "info" | "warn" | "bad";
  message: string;
};

export type GraphNode = {
  id: string;
  type: "venv" | "base" | "task" | "artifact";
  label: string;
  path?: string;
  python?: { version?: string; impl?: string; arch?: string };
  health?: {
    status: GraphHealthStatus;
    score?: number;
    issues?: GraphIssue[];
  };
  caps?: {
    packages?: Array<{ name: string; version?: string }>;
    features?: string[];
    tags?: string[];
  };
  fingerprints?: {
    env?: string;
    python?: string;
    packages?: string;
  };
  lastSeenAt?: string;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type:
    | "USES_BASE"
    | "CREATED_FROM"
    | "ROUTES_TASK_TO"
    | "FAILED_RUN"
    | "SHARES_WHEELHOUSE"
    | "SHADOWS_PATH";
  label?: string;
  weight?: number;
  meta?: Record<string, unknown>;
};

export type GraphSummary = {
  envCount: number;
  baseCount: number;
  taskCount: number;
  healthy: number;
  warning: number;
  broken: number;
  runsPassed: number;
  runsFailed: number;
  topIssues: Array<{ code: string; count: number; hint: string }>;
};

export type GraphJSONv1 = {
  version: "1.0";
  generatedAt: string;
  host: { os: string; arch: string; hostname: string };
  summary: GraphSummary;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type MapInsight = {
  severity: "low" | "medium" | "high";
  text: string;
  meta?: Record<string, unknown>;
};

export type MapRenderOptions = {
  format?: "json" | "mermaid" | "both";
  focus?: "all" | "project" | "capability" | "recent_failures";
  filter?: {
    minScore?: number;
    codes?: string[]; // only include envs that have any of these finding codes
    pathsUnder?: string;
    tags?: string[];
  };
  includeBaseSubgraphs?: boolean;
  includeHotEdgeLabels?: boolean; // label base->env edges with dominant issue emoji/code
  maxTopIssues?: number;
  taskMode?: "none" | "runs" | "clustered"; // default "clustered"
};

export type MapRenderResult = {
  graph: GraphJSONv1;
  mermaid?: string;
  insights: MapInsight[];
};

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function stableId(prefix: string, input: string) {
  return `${prefix}:${sha256Hex(input).slice(0, 16)}`;
}

function normPath(p?: string) {
  if (!p) return "";
  return os.platform() === "win32" ? p.toLowerCase() : p;
}

function pickArch(facts?: DoctorLiteReport["facts"]) {
  // facts.bits is numeric; we can convert to x86_64-ish label for the map
  const bits = facts?.bits;
  if (bits === 64) return "x86_64";
  if (bits === 32) return "x86";
  return undefined;
}

function statusFromReport(r: DoctorLiteReport): GraphHealthStatus {
  return r.status ?? "unknown";
}

function issuesFromFindings(findings: Finding[]): GraphIssue[] {
  return findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    message: f.what,
  }));
}

function shouldIncludeReport(r: DoctorLiteReport, opts: MapRenderOptions): boolean {
  const minScore = opts.filter?.minScore;
  if (typeof minScore === "number" && (r.score ?? 0) < minScore) return false;

  const under = opts.filter?.pathsUnder;
  if (under) {
    const p = normPath(r.pythonPath);
    if (!p.startsWith(normPath(under))) return false;
  }

  const codes = opts.filter?.codes;
  if (codes && codes.length > 0) {
    const set = new Set<string>(r.findings.map((f) => f.code));
    if (!codes.some((c) => set.has(c))) return false;
  }

  // tags aren't in DoctorLiteReport by default; keep hook for future
  return true;
}

function hintForIssue(code: string): string {
  switch (code) {
    case "SSL_BROKEN":
      return "Fix base Python / OpenSSL; this blocks installs and HTTPS.";
    case "DLL_LOAD_FAIL":
    case "ABI_MISMATCH":
      return "Native deps mismatch; recreate venv with compatible Python + wheels.";
    case "USER_SITE_LEAK":
    case "PYTHONPATH_INJECTED":
      return "Path leakage; disable user-site, remove PYTHONPATH, prefer editable installs.";
    case "PIP_CHECK_FAIL":
      return "Dependency conflicts; pip check then reinstall or recreate venv.";
    case "PYVENV_CFG_INVALID":
      return "Stale pyvenv.cfg; venv likely moved—recreate it.";
    default:
      return "Investigate and apply the doctor fix plan; recreating the venv is often fastest.";
  }
}

function emojiForIssue(code: string): string {
  switch (code) {
    case "SSL_BROKEN":
      return "🔒";
    case "CERT_STORE_FAIL":
      return "🪪";
    case "DLL_LOAD_FAIL":
      return "🧩";
    case "ABI_MISMATCH":
      return "⚙️";
    case "USER_SITE_LEAK":
      return "🕳️";
    case "PYTHONPATH_INJECTED":
      return "🧵";
    case "PIP_CHECK_FAIL":
      return "🧨";
    case "PIP_MISSING":
      return "📦";
    case "ARCH_MISMATCH":
      return "🏗️";
    case "PYVENV_CFG_INVALID":
      return "🧱";
    default:
      return "❗";
  }
}

function safeMermaidId(nodeId: string) {
  // Mermaid IDs must be simple. Use deterministic hash.
  return `n_${sha256Hex(nodeId).slice(0, 10)}`;
}

function guessEnvLabel(pythonPath: string): string {
  const parts = pythonPath.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[Math.max(0, parts.length - 2)] ?? pythonPath : pythonPath;
}

function mermaidLabel(node: GraphNode): string {
  const py = node.python?.version ? `py${node.python.version}` : "";
  const score = typeof node.health?.score === "number" ? `score ${node.health.score}` : "";
  const caps = (node.caps?.features?.length ? node.caps.features.slice(0, 3).join(",") : "") || "";
  const line2 = [py, score, caps].filter(Boolean).join(" • ");
  const lines = [node.label, line2].filter(Boolean);
  // Mermaid supports <br/> inside quoted labels
  return lines.join("<br/>");
}

function mermaidClass(status: GraphHealthStatus) {
  if (status === "good") return "good";
  if (status === "warn") return "warn";
  if (status === "bad") return "bad";
  return "unknown";
}

function countTopIssues(reports: DoctorLiteReport[], maxTop: number) {
  const counts = new Map<string, number>();
  for (const r of reports) {
    for (const f of r.findings) {
      if (f.severity === "info") continue;
      counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTop)
    .map(([code, count]) => ({ code, count, hint: hintForIssue(code) }));
}

function aggregateInsights(
  graph: GraphJSONv1,
  reports: DoctorLiteReport[],
  clusters: TaskCluster[] = []
): MapInsight[] {
  const insights: MapInsight[] = [];

  const top = graph.summary.topIssues;
  if (top.length > 0) {
    const t0 = top[0];
    if (t0) {
      insights.push({
        severity: t0.count >= 3 ? "high" : "medium",
        text: `Top recurring issue: ${t0.code} (${t0.count}). ${t0.hint}`,
        meta: { code: t0.code, count: t0.count },
      });
    }
  }

  // Blast radius: base -> many bad/warn envs or shared bad issue codes
  const baseNodes = graph.nodes.filter((n) => n.type === "base");
  for (const base of baseNodes) {
    const childrenEdges = graph.edges.filter((e) => e.type === "USES_BASE" && e.from === base.id);
    const childIds = childrenEdges.map((e) => e.to);
    const childNodes = graph.nodes.filter((n) => childIds.includes(n.id));
    const badCount = childNodes.filter((n) => n.health?.status === "bad").length;

    if (childNodes.length >= 3 && badCount >= Math.ceil(childNodes.length / 2)) {
      insights.push({
        severity: "high",
        text: `Base interpreter "${base.label}" has a large blast radius: ${badCount}/${childNodes.length} attached envs are bad. Fix the base first, then recreate envs.`,
        meta: { baseId: base.id, total: childNodes.length, bad: badCount },
      });
    }
  }

  // Ecosystem hygiene: PYTHONPATH + user site leaks
  const leakCount = reports.reduce((n, r) => n + (r.findings.some((f) => f.code === "USER_SITE_LEAK") ? 1 : 0), 0);
  const pyPathCount = reports.reduce((n, r) => n + (r.findings.some((f) => f.code === "PYTHONPATH_INJECTED") ? 1 : 0), 0);

  if (leakCount >= 2 || pyPathCount >= 2) {
    insights.push({
      severity: "high",
      text: `Ecosystem hygiene problem: USER_SITE_LEAK in ${leakCount} env(s), PYTHONPATH_INJECTED in ${pyPathCount} env(s). This causes "works here, fails there." Lock these down (PYTHONNOUSERSITE=1, remove PYTHONPATH).`,
      meta: { leakCount, pyPathCount },
    });
  }

  // "Nuclear option" recommendation when too many unique issues show up
  const uniqueIssues = new Set<string>();
  for (const r of reports) for (const f of r.findings) if (f.severity !== "info") uniqueIssues.add(f.code);
  if (reports.length >= 5 && uniqueIssues.size >= 8) {
    insights.push({
      severity: "medium",
      text: `High entropy detected: ${uniqueIssues.size} different issue types across ${reports.length} envs. Consider standardizing on 2–3 "golden envs" (data, web, ml) and routing tasks into them.`,
      meta: { envs: reports.length, uniqueIssues: uniqueIssues.size },
    });
  }

  // --- Flaky task detection ---
  const flakyTasks = clusters.filter(isFlaky).slice(0, 3);
  for (const c of flakyTasks) {
    const failingEnvs = getFailingEnvs(c, 2);
    const envHint =
      failingEnvs.length > 0
        ? ` Failures concentrated in: ${failingEnvs.map((e) => guessEnvLabel(e.pythonPath)).join(", ")}.`
        : "";

    insights.push({
      severity: "high",
      text: `Flaky task detected: "${c.sig.name}" (success ${(c.successRate * 100).toFixed(0)}%, ${c.runs} runs). Dominant failure: ${c.dominantFailure ?? "unknown"}.${envHint}`,
      meta: {
        taskSig: c.sig.sigId,
        runs: c.runs,
        successRate: c.successRate,
        dominantFailure: c.dominantFailure,
      },
    });
  }

  // --- Env-dependent flake detection ---
  const envFlakyTasks = clusters.filter(isEnvDependentFlaky).slice(0, 2);
  for (const c of envFlakyTasks) {
    if (flakyTasks.includes(c)) continue; // already reported

    const failingEnvs = getFailingEnvs(c, 2);
    insights.push({
      severity: "high",
      text: `Env-dependent flake: "${c.sig.name}" succeeds on some envs but fails on others. Problem envs: ${failingEnvs.map((e) => guessEnvLabel(e.pythonPath)).join(", ")}.`,
      meta: { taskSig: c.sig.sigId, failingEnvs: failingEnvs.map((e) => e.pythonPath) },
    });
  }

  // --- Failure bottleneck envs ---
  const failByEnv = new Map<string, number>();
  for (const e of graph.edges.filter((e) => e.type === "FAILED_RUN")) {
    failByEnv.set(e.to, (failByEnv.get(e.to) ?? 0) + (e.weight ?? 1));
  }
  const worstEnvs = [...failByEnv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [envId, failCount] of worstEnvs) {
    if (failCount < 3) continue; // only report significant hotspots
    const env = graph.nodes.find((n) => n.id === envId);
    if (!env) continue;
    insights.push({
      severity: "high",
      text: `Failure hotspot: env "${env.label}" is associated with ${failCount} failing runs. Consider rebuilding it or isolating it from routing.`,
      meta: { envId, failCount },
    });
  }

  // --- Contagion: most failures share a common issue ---
  if (clusters.length > 0) {
    const failureCodeCounts = new Map<string, number>();
    for (const c of clusters) {
      for (const [code, count] of Object.entries(c.failureCounts)) {
        failureCodeCounts.set(code, (failureCodeCounts.get(code) ?? 0) + count);
      }
    }
    const totalFailures = graph.summary.runsFailed;
    const topFailureCode = [...failureCodeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topFailureCode && totalFailures > 0 && topFailureCode[1] / totalFailures >= 0.5) {
      insights.push({
        severity: "high",
        text: `Most failures (${topFailureCode[1]}/${totalFailures}) share the same root cause: ${topFailureCode[0]}. ${hintForIssue(topFailureCode[0])}`,
        meta: { code: topFailureCode[0], count: topFailureCode[1], totalFailures },
      });
    }
  }

  if (insights.length === 0) {
    insights.push({ severity: "low", text: "No major systemic risks detected. Keep env count small and prefer reproducible installs." });
  }

  return insights;
}

function dominantIssue(findings: Finding[]): string | null {
  // Pick the highest-penalty non-info code as "dominant"
  const nonInfo = findings.filter((f) => f.severity !== "info");
  if (nonInfo.length === 0) return null;
  nonInfo.sort((a, b) => (b.penalty ?? 0) - (a.penalty ?? 0));
  return nonInfo[0]?.code ?? null;
}

function deriveBaseKey(r: DoctorLiteReport): string {
  // Best-effort base grouping:
  // - If it's a venv, facts.base_prefix is the base interpreter prefix directory.
  // - Otherwise, group by prefix/executable directory.
  const f = r.facts;
  const basePrefix = typeof f?.base_prefix === "string" && f.base_prefix.length ? f.base_prefix : "";
  if (basePrefix) return basePrefix;

  const prefix = typeof f?.prefix === "string" ? f.prefix : "";
  if (prefix) return prefix;

  // Fall back to executable path parent
  return r.pythonPath;
}

function derivePyVersion(r: DoctorLiteReport): string | undefined {
  const vi = r.facts?.version_info;
  if (Array.isArray(vi) && vi.length >= 2) return `${vi[0]}.${vi[1]}`;
  // fall back to parsing "version" if present
  const v = r.facts?.version;
  const m = v?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (m) return `${m[1]}.${m[2]}`;
  return undefined;
}

function deriveImpl(): string {
  // DoctorLite facts don't include impl explicitly; default CPython
  return "CPython";
}

function nodeLabelForBase(baseKey: string, pyVersion?: string, arch?: string) {
  // Keep it readable: show the directory/prefix, not entire story.
  return `Base: ${pyVersion ?? "py?"} ${arch ?? ""}\n${baseKey}`;
}

function summarizeCounts(nodes: GraphNode[]) {
  const venvs = nodes.filter((n) => n.type === "venv");
  const healthy = venvs.filter((n) => n.health?.status === "good").length;
  const warning = venvs.filter((n) => n.health?.status === "warn").length;
  const broken = venvs.filter((n) => n.health?.status === "bad").length;
  return { healthy, warning, broken };
}

export function mapRender(
  reports: DoctorLiteReport[],
  runs: RunLogEventV1[] = [],
  options: MapRenderOptions = {}
): MapRenderResult {
  const opts: Required<MapRenderOptions> = {
    format: options.format ?? "both",
    focus: options.focus ?? "all",
    filter: options.filter ?? {},
    includeBaseSubgraphs: options.includeBaseSubgraphs ?? true,
    includeHotEdgeLabels: options.includeHotEdgeLabels ?? true,
    maxTopIssues: options.maxTopIssues ?? 10,
    taskMode: options.taskMode ?? "clustered",
  };

  const included = reports.filter((r) => shouldIncludeReport(r, opts));

  // Build nodes/edges
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const baseIdByKey = new Map<string, string>();
  const envIdByPyPath = new Map<string, string>();

  // Helper: create/get base node
  const getOrCreateBaseNode = (baseKey: string, pyVersion?: string, arch?: string) => {
    const keyNorm = normPath(baseKey);
    let id = baseIdByKey.get(keyNorm);
    if (!id) {
      id = stableId("base", keyNorm);
      baseIdByKey.set(keyNorm, id);

      nodes.push({
        id,
        type: "base",
        label: nodeLabelForBase(baseKey, pyVersion, arch).replace(/\n/g, " • "),
        path: baseKey,
        python: { version: pyVersion, impl: deriveImpl(), arch },
        health: { status: "unknown" },
        fingerprints: { python: `sha256:${sha256Hex(keyNorm).slice(0, 24)}` },
        lastSeenAt: nowIso(),
      });
    }
    return id;
  };

  // Create env nodes + base edges
  for (const r of included) {
    const pyPath = normPath(r.pythonPath);
    const envId = stableId("env", pyPath);
    envIdByPyPath.set(pyPath, envId);

    const pyVersion = derivePyVersion(r);
    const arch = pickArch(r.facts);

    const dominant = dominantIssue(r.findings);
    const envFingerprint = `sha256:${sha256Hex(pyPath + "|" + String(pyVersion) + "|" + (dominant ?? "")).slice(0, 24)}`;

    nodes.push({
      id: envId,
      type: "venv",
      label: (() => {
        // Friendly: show just last folder name for venv-ish paths
        const parts = r.pythonPath.split(/[\\/]+/).filter(Boolean);
        const guess = parts.length ? parts[Math.max(0, parts.length - 2)] : r.pythonPath;
        return guess ?? r.pythonPath;
      })(),
      path: r.pythonPath,
      python: { version: pyVersion, impl: deriveImpl(), arch },
      health: {
        status: statusFromReport(r),
        score: r.score,
        issues: issuesFromFindings(r.findings),
      },
      caps: {
        // DoctorLite doesn't enumerate packages; we still include signals as "features"
        features: [
          r.findings.some((f) => f.code === "SSL_BROKEN") ? "ssl:broken" : "ssl:ok",
          r.findings.some((f) => f.code === "USER_SITE_LEAK") ? "usersite:leak" : "usersite:clean",
          r.findings.some((f) => f.code === "PYTHONPATH_INJECTED") ? "pythonpath:set" : "pythonpath:clean",
        ],
        tags: [],
      },
      fingerprints: { env: envFingerprint },
      lastSeenAt: r.ranAt ?? nowIso(),
    });

    // Base grouping
    const baseKey = deriveBaseKey(r);
    const baseId = getOrCreateBaseNode(baseKey, pyVersion, arch);

    edges.push({
      id: stableId("e", `${baseId}->${envId}`),
      from: baseId,
      to: envId,
      type: "USES_BASE",
      weight: 1,
      meta: { dominantIssue: dominant },
    });
  }

  // Improve base health by aggregating child env health (so the map reflects blast radius)
  for (const base of nodes.filter((n) => n.type === "base")) {
    const childEdges = edges.filter((e) => e.type === "USES_BASE" && e.from === base.id);
    const childNodes = nodes.filter((n) => childEdges.some((e) => e.to === n.id));
    if (childNodes.length === 0) continue;

    // Base score is median of child scores (more stable than min), but status is worst-case
    const scores = childNodes
      .map((n) => n.health?.score)
      .filter((s): s is number => typeof s === "number")
      .sort((a, b) => a - b);
    const median = scores.length ? scores[Math.floor(scores.length / 2)] : undefined;

    const worst =
      childNodes.some((n) => n.health?.status === "bad")
        ? "bad"
        : childNodes.some((n) => n.health?.status === "warn")
          ? "warn"
          : childNodes.some((n) => n.health?.status === "good")
            ? "good"
            : "unknown";

    base.health = { status: worst, score: median };
  }

  // --- Task nodes + edges from run logs ---
  let runsPassed = 0;
  let runsFailed = 0;
  let clusters: TaskCluster[] = [];

  // Build node index for quick lookups
  const nodeIndex = new Map<string, GraphNode>();
  for (const n of nodes) nodeIndex.set(n.id, n);

  if (opts.taskMode !== "none" && runs.length > 0) {
    // Count totals regardless of mode
    for (const r of runs) {
      if (r.outcome.ok) runsPassed++;
      else runsFailed++;
    }

    if (opts.taskMode === "clustered") {
      // Clustered mode: one task node per signature
      clusters = clusterRuns(runs);

      for (const c of clusters) {
        const taskId = `task:${c.sig.sigId}`;

        const flaky = isFlaky(c);
        const envFlaky = isEnvDependentFlaky(c);

        nodes.push({
          id: taskId,
          type: "task",
          label: c.sig.name,
          health: {
            status: c.fail === 0 ? "good" : c.ok === 0 ? "bad" : "warn",
            score: Math.round(100 * c.successRate),
            issues: c.dominantFailure
              ? [
                  {
                    code: c.dominantFailure,
                    severity: c.fail > 0 ? "warn" : "info",
                    message: `dominant failure (${c.failureCounts[c.dominantFailure]})`,
                  },
                ]
              : [],
          },
          caps: {
            features: [
              `runs:${c.runs}`,
              `ok:${c.ok}`,
              `fail:${c.fail}`,
              flaky ? "flaky:true" : "flaky:false",
              envFlaky ? "env-flaky:true" : "env-flaky:false",
            ],
            tags: [],
          },
          lastSeenAt: c.lastAt,
        });
        nodeIndex.set(taskId, nodes[nodes.length - 1]!);

        // Build weighted edges to envs
        for (const [pyPath, count] of Object.entries(c.envCounts)) {
          const envPy = normPath(pyPath);
          const envId = envIdByPyPath.get(envPy) ?? stableId("env", envPy);

          // Ensure env node exists even if missing from reports
          if (!nodeIndex.has(envId)) {
            const label = guessEnvLabel(pyPath);
            const newEnvNode: GraphNode = {
              id: envId,
              type: "venv",
              label,
              path: pyPath,
              health: { status: "unknown" },
              lastSeenAt: c.lastAt,
            };
            nodes.push(newEnvNode);
            nodeIndex.set(envId, newEnvNode);
            envIdByPyPath.set(envPy, envId);
          }

          edges.push({
            id: stableId("e", `${taskId}->${envId}:route`),
            from: taskId,
            to: envId,
            type: "ROUTES_TASK_TO",
            label: `x${count}`,
            weight: count,
            meta: { taskSig: c.sig.sigId },
          });

          const failCount = c.envFailCounts[pyPath] ?? 0;
          if (failCount > 0) {
            const dom = c.dominantFailure ?? "RUN_FAILED";
            edges.push({
              id: stableId("e", `${taskId}->${envId}:fail`),
              from: taskId,
              to: envId,
              type: "FAILED_RUN",
              label: `${emojiForIssue(dom)} ${dom} x${failCount}`,
              weight: failCount,
              meta: { taskSig: c.sig.sigId, dominantIssue: dom },
            });
          }
        }
      }
    } else {
      // "runs" mode: one task node per run (original behavior)
      for (const run of runs) {
        const taskKey = `${run.task.name}|${run.task.command}|${run.at}|${run.selected.pythonPath}`;
        const taskId = stableId("task", run.runId || taskKey);

        nodes.push({
          id: taskId,
          type: "task",
          label: run.task.name,
          path: run.cwd,
          health: {
            status: run.outcome.ok ? "good" : "bad",
            score: run.outcome.ok ? 100 : 40,
            issues: run.outcome.ok
              ? []
              : [
                  {
                    code: run.outcome.errorClass ?? "RUN_FAILED",
                    severity: "bad",
                    message: run.outcome.stderrSnippet ?? "Task failed",
                  },
                ],
          },
          caps: {
            features: [
              run.task.requirements?.packages?.length
                ? `pkgs:${run.task.requirements.packages.slice(0, 3).join(",")}`
                : "pkgs:none",
            ],
            tags: run.task.requirements?.tags ?? [],
          },
          lastSeenAt: run.at,
        });
        nodeIndex.set(taskId, nodes[nodes.length - 1]!);

        const envPy = normPath(run.selected.pythonPath);
        const envId = envIdByPyPath.get(envPy) ?? stableId("env", envPy);

        if (!nodeIndex.has(envId)) {
          const newEnvNode: GraphNode = {
            id: envId,
            type: "venv",
            label: guessEnvLabel(run.selected.pythonPath),
            path: run.selected.pythonPath,
            health: { status: run.selected.status ?? "unknown", score: run.selected.score },
            lastSeenAt: run.at,
          };
          nodes.push(newEnvNode);
          nodeIndex.set(envId, newEnvNode);
          envIdByPyPath.set(envPy, envId);
        }

        edges.push({
          id: stableId("e", `${taskId}->${envId}:route`),
          from: taskId,
          to: envId,
          type: "ROUTES_TASK_TO",
          label: "routes",
          weight: 1,
          meta: { runId: run.runId, command: run.task.command },
        });

        if (!run.outcome.ok) {
          const dom = run.doctor?.dominantIssue ?? run.outcome.errorClass ?? "RUN_FAILED";
          edges.push({
            id: stableId("e", `${taskId}->${envId}:fail`),
            from: taskId,
            to: envId,
            type: "FAILED_RUN",
            label: `${emojiForIssue(dom)} ${dom}`,
            weight: 2,
            meta: { runId: run.runId, exitCode: run.outcome.exitCode, dominantIssue: dom },
          });
        }
      }
    }
  }

  // Summary + insights
  const { healthy, warning, broken } = summarizeCounts(nodes);
  const topIssues = countTopIssues(included, opts.maxTopIssues);

  const graph: GraphJSONv1 = {
    version: "1.0",
    generatedAt: nowIso(),
    host: {
      os: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
    },
    summary: {
      envCount: nodes.filter((n) => n.type === "venv").length,
      baseCount: nodes.filter((n) => n.type === "base").length,
      taskCount: nodes.filter((n) => n.type === "task").length,
      healthy,
      warning,
      broken,
      runsPassed,
      runsFailed,
      topIssues,
    },
    nodes,
    edges,
  };

  const insights = aggregateInsights(graph, included, clusters);

  let mermaid: string | undefined;
  if (opts.format === "mermaid" || opts.format === "both") {
    mermaid = renderMermaid(graph, {
      includeBaseSubgraphs: opts.includeBaseSubgraphs,
      includeHotEdgeLabels: opts.includeHotEdgeLabels,
    });
  }

  return { graph, mermaid, insights };
}

export type MermaidRenderOptions = {
  includeBaseSubgraphs?: boolean;
  includeHotEdgeLabels?: boolean;
};

export function renderMermaid(graph: GraphJSONv1, opts: MermaidRenderOptions = {}): string {
  const includeSubgraphs = opts.includeBaseSubgraphs ?? true;
  const hotEdges = opts.includeHotEdgeLabels ?? true;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const baseNodes = graph.nodes.filter((n) => n.type === "base");

  const idMap = new Map<string, string>();
  for (const n of graph.nodes) idMap.set(n.id, safeMermaidId(n.id));

  const lines: string[] = [];
  lines.push("graph TD");

  // Nodes
  for (const n of graph.nodes) {
    const mid = idMap.get(n.id)!;
    const label = mermaidLabel(n);
    const cls =
      n.type === "base"
        ? "base"
        : n.type === "task"
          ? "task"
          : mermaidClass(n.health?.status ?? "unknown");
    lines.push(`  ${mid}["${escapeMermaid(label)}"]:::${cls}`);
  }

  // Edges
  const usesBase = graph.edges.filter((e) => e.type === "USES_BASE");
  for (const e of usesBase) {
    const from = idMap.get(e.from)!;
    const to = idMap.get(e.to)!;

    let label = "USES_BASE";
    if (hotEdges) {
      const dom = (e.meta as Record<string, unknown> | undefined)?.dominantIssue as string | undefined;
      if (dom) label = `${emojiForIssue(dom)} ${dom}`;
    }
    lines.push(`  ${from} -->|${escapeMermaid(label)}| ${to}`);
  }

  // Optional: cluster venvs under base interpreters
  if (includeSubgraphs && baseNodes.length > 0) {
    // Mermaid subgraphs need nodes referenced inside; we'll emit them as comments + group edges do the real wiring.
    // For readability, we add subgraph blocks listing the venv nodes.
    for (const base of baseNodes) {
      const baseMid = idMap.get(base.id)!;
      const attached = usesBase
        .filter((e) => e.from === base.id)
        .map((e) => nodeById.get(e.to))
        .filter((n): n is GraphNode => Boolean(n))
        .filter((n) => n.type === "venv");

      if (attached.length === 0) continue;

      lines.push(`  subgraph ${baseMid}_cluster["${escapeMermaid(base.label)}"]`);
      for (const v of attached) {
        const vmid = idMap.get(v.id)!;
        // Reference node within subgraph (no redefinition; mermaid tolerates this as a bare identifier)
        lines.push(`    ${vmid}`);
      }
      lines.push("  end");
    }
  }

  // Task edges: ROUTES_TASK_TO + FAILED_RUN
  const taskEdges = graph.edges.filter((e) => e.type === "ROUTES_TASK_TO" || e.type === "FAILED_RUN");
  for (const e of taskEdges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to) continue;

    const label = e.label ?? e.type;
    const style = e.type === "FAILED_RUN" ? " -.->|" : " -->|";
    lines.push(`  ${from}${style}${escapeMermaid(label)}| ${to}`);
  }

  // Styles
  lines.push("");
  lines.push("  classDef good fill:#eaffea,stroke:#2b8a3e,stroke-width:1px;");
  lines.push("  classDef warn fill:#fff4d6,stroke:#b7791f,stroke-width:1px;");
  lines.push("  classDef bad fill:#ffe3e3,stroke:#c92a2a,stroke-width:1px;");
  lines.push("  classDef unknown fill:#f1f3f5,stroke:#868e96,stroke-width:1px;");
  lines.push("  classDef base fill:#e7f5ff,stroke:#1c7ed6,stroke-width:1px;");
  lines.push("  classDef task fill:#f8f0fc,stroke:#862e9c,stroke-width:1px;");

  // "Legend" node (tiny special touch)
  lines.push("");
  lines.push('  legend["Legend<br/>green=good • yellow=warn • red=bad • purple=task<br/>edge label = dominant failure"]:::unknown');

  return lines.join("\n");
}

function escapeMermaid(s: string) {
  // Keep Mermaid happy inside quotes/edge labels
  return s.replace(/"/g, '\\"').replace(/\|/g, "\\|");
}
