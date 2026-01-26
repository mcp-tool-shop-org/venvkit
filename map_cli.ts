#!/usr/bin/env node
// map_cli.ts
//
// CLI that scans envs, runs doctorLite, renders Mermaid + JSON graph.
// Writes outputs to disk and prints Mermaid to stdout.
//
// Usage examples:
//   node dist/map_cli.js --root C:\repo --out .venvkit
//   node dist/map_cli.js --root . --maxDepth 6 --strict --httpsProbe
//
// Outputs:
//   <out>/venv-map.json
//   <out>/venv-map.mmd
//   <out>/venv-map.html (optional viewer)
//   <out>/reports.json (raw doctorLite reports)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { scanEnvPaths } from "./scanEnvPaths.js";
import { doctorLite } from "./doctorLite.js";
import { mapRender } from "./mapRender.js";
import { readRunLog } from "./runLog.js";

type Args = {
  roots: string[];
  outDir: string;
  maxDepth: number;
  strict: boolean;
  httpsProbe: boolean;
  minScore?: number;
  concurrency: number;
  runLogPath?: string;
  includeTasks: boolean;
};

function parseArgs(argv: string[]): Args {
  const roots: string[] = [];
  let outDir = path.join(process.cwd(), ".venvkit");
  let maxDepth = 5;
  let strict = false;
  let httpsProbe = false;
  let minScore: number | undefined;
  let concurrency = Math.max(2, Math.min(8, os.cpus().length));
  let runLogPath: string | undefined;
  let includeTasks = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "-r") roots.push(argv[++i] ?? "");
    else if (a === "--out") outDir = argv[++i] ?? outDir;
    else if (a === "--maxDepth") maxDepth = Number(argv[++i]);
    else if (a === "--strict") strict = true;
    else if (a === "--httpsProbe") httpsProbe = true;
    else if (a === "--minScore") minScore = Number(argv[++i]);
    else if (a === "--concurrency") concurrency = Number(argv[++i]);
    else if (a === "--runlog") runLogPath = argv[++i];
    else if (a === "--no-tasks") includeTasks = false;
  }

  if (roots.length === 0) roots.push(process.cwd());

  return { roots, outDir, maxDepth, strict, httpsProbe, minScore, concurrency, runLogPath, includeTasks };
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function writeText(p: string, s: string) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, s, "utf8");
}

async function writeJson(p: string, obj: unknown) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

// Simple concurrency pool
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const my = idx++;
      const item = items[my];
      if (item !== undefined) {
        out[my] = await fn(item);
      }
    }
  });

  await Promise.all(workers);
  return out;
}

function htmlViewerTemplate() {
  // Single-file viewer: loads venv-map.json from same directory and renders:
  // - summary
  // - insights
  // - mermaid diagram via mermaid CDN
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>venvkit map</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 20px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; }
    .muted { color: #6b7280; }
    pre { background: #0b1020; color: #e5e7eb; padding: 12px; border-radius: 12px; overflow: auto; }
    .pill { display:inline-block; padding: 3px 8px; border-radius: 999px; border: 1px solid #e5e7eb; margin-right: 6px; }
    .good { background:#eaffea; }
    .warn { background:#fff4d6; }
    .bad { background:#ffe3e3; }
  </style>
</head>
<body>
  <h1>venvkit map</h1>
  <div id="meta" class="muted"></div>

  <div class="row" style="margin-top:12px;">
    <div class="card">
      <h3>Summary</h3>
      <div id="summary"></div>
      <div style="margin-top:10px;">
        <h4>Top issues</h4>
        <div id="topIssues"></div>
      </div>
    </div>
    <div class="card">
      <h3>Insights</h3>
      <div id="insights"></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
    <h3>Mermaid</h3>
    <div class="muted">Rendered from <code>venv-map.mmd</code></div>
    <div class="mermaid" id="mermaid"></div>
  </div>

  <div class="card" style="margin-top:16px;">
    <h3>Graph JSON</h3>
    <div class="muted">From <code>venv-map.json</code></div>
    <pre id="json"></pre>
  </div>

  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: false });

    async function loadText(name) {
      const r = await fetch(name, { cache: "no-store" });
      return await r.text();
    }
    async function loadJson(name) {
      const r = await fetch(name, { cache: "no-store" });
      return await r.json();
    }

    function pill(text, cls) {
      const span = document.createElement("span");
      span.className = "pill " + (cls || "");
      span.textContent = text;
      return span;
    }

    const graph = await loadJson("./venv-map.json");
    const mmd = await loadText("./venv-map.mmd");

    document.getElementById("meta").textContent =
      "Generated: " + graph.generatedAt + " • Host: " + graph.host.hostname + " • " + graph.host.os + " • " + graph.host.arch;

    const s = graph.summary;
    const sum = document.getElementById("summary");
    sum.appendChild(pill("envs: " + s.envCount));
    sum.appendChild(pill("bases: " + s.baseCount));
    sum.appendChild(pill("good: " + s.healthy, "good"));
    sum.appendChild(pill("warn: " + s.warning, "warn"));
    sum.appendChild(pill("bad: " + s.broken, "bad"));

    const top = document.getElementById("topIssues");
    (s.topIssues || []).forEach(x => {
      const div = document.createElement("div");
      div.style.marginBottom = "6px";
      div.innerHTML = "<b>" + x.code + "</b> (" + x.count + ")<div class='muted'>" + x.hint + "</div>";
      top.appendChild(div);
    });

    // Insights live in results.json normally; but we can display from a sibling file if present
    // If not present, show fallback.
    let insights = [];
    try { insights = await loadJson("./insights.json"); } catch {}
    const ins = document.getElementById("insights");
    if (!insights.length) {
      ins.innerHTML = "<div class='muted'>No insights file found.</div>";
    } else {
      insights.forEach(x => {
        const div = document.createElement("div");
        div.style.marginBottom = "10px";
        div.innerHTML = "<b>" + x.severity.toUpperCase() + "</b><div>" + x.text + "</div>";
        ins.appendChild(div);
      });
    }

    document.getElementById("mermaid").textContent = mmd;
    await mermaid.run({ nodes: [document.getElementById("mermaid")] });

    document.getElementById("json").textContent = JSON.stringify(graph, null, 2);
  </script>
</body>
</html>`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  await ensureDir(args.outDir);

  process.stderr.write(`Scanning for Python environments in: ${args.roots.join(", ")}\n`);

  const scan = await scanEnvPaths({
    roots: args.roots,
    maxDepth: args.maxDepth,
    includeHidden: false,
    includeUserHomeCache: true,
  });

  process.stderr.write(`Found ${scan.pythonPaths.length} Python executables (${scan.meta.foundVenvs} venvs, ${scan.meta.foundBases} bases)\n`);

  if (scan.pythonPaths.length === 0) {
    process.stderr.write("No Python environments found. Nothing to do.\n");
    return;
  }

  process.stderr.write(`Running doctorLite on ${scan.pythonPaths.length} environments (concurrency: ${args.concurrency})...\n`);

  // Run doctorLite in parallel
  const reports = await mapLimit(scan.pythonPaths, args.concurrency, async (pythonPath) => {
    return doctorLite(
      {
        pythonPath,
        requiredModules: [], // router/task can supply later
        requireX64: true,
        strict: args.strict,
        httpsProbe: args.httpsProbe,
      },
      undefined
    );
  });

  // Load run logs if available
  const runLogPath = args.runLogPath ?? path.join(args.outDir, "runs.jsonl");
  const runs = args.includeTasks ? await readRunLog(runLogPath, { maxLines: 5000 }) : [];

  if (runs.length > 0) {
    process.stderr.write(`Loaded ${runs.length} task runs from ${runLogPath}\n`);
  }

  const { graph, mermaid, insights } = mapRender(reports, runs, {
    format: "both",
    filter: { minScore: args.minScore },
    includeBaseSubgraphs: true,
    includeHotEdgeLabels: true,
    maxTopIssues: 10,
  });

  // Write outputs
  const outJson = path.join(args.outDir, "venv-map.json");
  const outMmd = path.join(args.outDir, "venv-map.mmd");
  const outHtml = path.join(args.outDir, "venv-map.html");
  const outReports = path.join(args.outDir, "reports.json");
  const outInsights = path.join(args.outDir, "insights.json");

  await writeJson(outJson, graph);
  await writeText(outMmd, mermaid ?? "");
  await writeJson(outReports, reports);
  await writeJson(outInsights, insights);
  await writeText(outHtml, htmlViewerTemplate());

  // Print Mermaid to stdout so it shows up in logs immediately
  process.stdout.write((mermaid ?? "") + "\n");
  process.stderr.write(`\nWrote:\n  ${outJson}\n  ${outMmd}\n  ${outHtml}\n  ${outReports}\n  ${outInsights}\n\n`);

  // Summary
  const { summary } = graph;
  process.stderr.write(`Summary: ${summary.envCount} envs, ${summary.baseCount} bases, ${summary.taskCount} tasks\n`);
  process.stderr.write(`  good: ${summary.healthy}, warn: ${summary.warning}, bad: ${summary.broken}\n`);
  if (summary.taskCount > 0) {
    process.stderr.write(`  runs: ${summary.runsPassed} passed, ${summary.runsFailed} failed\n`);
  }
  if (summary.topIssues.length > 0) {
    process.stderr.write(`  Top issue: ${summary.topIssues[0]?.code} (${summary.topIssues[0]?.count})\n`);
  }
}

// ESM entry point detection
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
