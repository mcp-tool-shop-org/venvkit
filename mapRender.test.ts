// mapRender.test.ts
// Unit tests for mapRender ecosystem visualization

import { describe, it, expect } from "vitest";
import { mapRender, type GraphJSONv1, type MapInsight } from "./mapRender.js";
import type { DoctorLiteReport } from "./doctorLite.js";
import type { RunLogEventV1 } from "./runLog.js";

function makeReport(
  pythonPath: string,
  opts: {
    status?: "good" | "warn" | "bad";
    score?: number;
    findings?: DoctorLiteReport["findings"];
    basePrefix?: string;
    prefix?: string;
    versionInfo?: number[];
    bits?: number;
  } = {}
): DoctorLiteReport {
  return {
    pythonPath,
    ranAt: "2024-01-01T00:00:00Z",
    status: opts.status ?? "good",
    score: opts.score ?? 100,
    summary: "Test report",
    facts: {
      version: "3.11.5 (main)",
      version_info: opts.versionInfo ?? [3, 11, 5],
      executable: pythonPath,
      prefix: opts.prefix ?? pythonPath.replace(/[/\\]python\.exe$/, ""),
      base_prefix: opts.basePrefix ?? "C:\\Python311",
      bits: opts.bits ?? 64,
      machine: "AMD64",
      os: "windows",
      py_path: [],
      enable_user_site: false,
      user_site: "",
    },
    findings: opts.findings ?? [],
  };
}

describe("mapRender", () => {
  describe("graph generation", () => {
    it("creates nodes for each env and groups by base", () => {
      const reports = [
        makeReport("C:\\project1\\.venv\\Scripts\\python.exe", { basePrefix: "C:\\Python311" }),
        makeReport("C:\\project2\\.venv\\Scripts\\python.exe", { basePrefix: "C:\\Python311" }),
        makeReport("C:\\project3\\.venv\\Scripts\\python.exe", { basePrefix: "C:\\Python310" }),
      ];

      const result = mapRender(reports, []);

      expect(result.graph.summary.envCount).toBe(3);
      expect(result.graph.summary.baseCount).toBe(2); // Python311 + Python310
      expect(result.graph.nodes.filter((n) => n.type === "venv")).toHaveLength(3);
      expect(result.graph.nodes.filter((n) => n.type === "base")).toHaveLength(2);
    });

    it("creates USES_BASE edges from base to venv", () => {
      const reports = [
        makeReport("C:\\project\\.venv\\Scripts\\python.exe", { basePrefix: "C:\\Python311" }),
      ];

      const result = mapRender(reports, []);
      const usesBaseEdges = result.graph.edges.filter((e) => e.type === "USES_BASE");

      expect(usesBaseEdges).toHaveLength(1);
      expect(usesBaseEdges[0]?.from).toContain("base:");
      expect(usesBaseEdges[0]?.to).toContain("env:");
    });

    it("uses stable deterministic IDs based on path hash", () => {
      const reports = [makeReport("C:\\project\\.venv\\Scripts\\python.exe")];

      const result1 = mapRender(reports);
      const result2 = mapRender(reports);

      // IDs should be identical across runs
      expect(result1.graph.nodes.map((n) => n.id)).toEqual(result2.graph.nodes.map((n) => n.id));
      expect(result1.graph.edges.map((e) => e.id)).toEqual(result2.graph.edges.map((e) => e.id));
    });
  });

  describe("health aggregation", () => {
    it("aggregates base health from child venvs (worst-case status)", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", { status: "good", score: 90, basePrefix: "C:\\Python311" }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { status: "bad", score: 20, basePrefix: "C:\\Python311" }),
      ];

      const result = mapRender(reports, []);
      const baseNode = result.graph.nodes.find((n) => n.type === "base");

      expect(baseNode?.health?.status).toBe("bad"); // worst-case
    });

    it("computes median score for base from child scores", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", { score: 90, basePrefix: "C:\\Python311" }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { score: 50, basePrefix: "C:\\Python311" }),
        makeReport("C:\\p3\\.venv\\Scripts\\python.exe", { score: 30, basePrefix: "C:\\Python311" }),
      ];

      const result = mapRender(reports, []);
      const baseNode = result.graph.nodes.find((n) => n.type === "base");

      // Median of [30, 50, 90] = 50
      expect(baseNode?.health?.score).toBe(50);
    });

    it("counts healthy/warning/broken correctly in summary", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", { status: "good" }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { status: "good" }),
        makeReport("C:\\p3\\.venv\\Scripts\\python.exe", { status: "warn" }),
        makeReport("C:\\p4\\.venv\\Scripts\\python.exe", { status: "bad" }),
      ];

      const result = mapRender(reports, []);

      expect(result.graph.summary.healthy).toBe(2);
      expect(result.graph.summary.warning).toBe(1);
      expect(result.graph.summary.broken).toBe(1);
    });
  });

  describe("insights", () => {
    it("detects blast radius when base has many bad envs", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", { status: "bad", basePrefix: "C:\\Python311" }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { status: "bad", basePrefix: "C:\\Python311" }),
        makeReport("C:\\p3\\.venv\\Scripts\\python.exe", { status: "bad", basePrefix: "C:\\Python311" }),
      ];

      const result = mapRender(reports, []);
      const blastRadius = result.insights.find((i) => i.text.includes("blast radius"));

      expect(blastRadius).toBeDefined();
      expect(blastRadius?.severity).toBe("high");
    });

    it("detects ecosystem hygiene issues (USER_SITE_LEAK, PYTHONPATH)", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "USER_SITE_LEAK", severity: "warn", penalty: 20, what: "leak", why: "why", fix: [] }],
        }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "USER_SITE_LEAK", severity: "warn", penalty: 20, what: "leak", why: "why", fix: [] }],
        }),
      ];

      const result = mapRender(reports, []);
      const hygiene = result.insights.find((i) => i.text.includes("hygiene"));

      expect(hygiene).toBeDefined();
      expect(hygiene?.severity).toBe("high");
    });

    it("reports top issues with hints", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "SSL_BROKEN", severity: "bad", penalty: 40, what: "ssl", why: "why", fix: [] }],
        }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "SSL_BROKEN", severity: "bad", penalty: 40, what: "ssl", why: "why", fix: [] }],
        }),
      ];

      const result = mapRender(reports, []);

      expect(result.graph.summary.topIssues.length).toBeGreaterThan(0);
      expect(result.graph.summary.topIssues[0]?.code).toBe("SSL_BROKEN");
      expect(result.graph.summary.topIssues[0]?.count).toBe(2);
      expect(result.graph.summary.topIssues[0]?.hint).toContain("OpenSSL");
    });
  });

  describe("filtering", () => {
    it("filters by minScore", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", { score: 90 }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { score: 40 }),
      ];

      const result = mapRender(reports, [], { filter: { minScore: 50 } });

      expect(result.graph.summary.envCount).toBe(1);
    });

    it("filters by pathsUnder", () => {
      const reports = [
        makeReport("C:\\workspace\\project\\.venv\\Scripts\\python.exe"),
        makeReport("D:\\other\\.venv\\Scripts\\python.exe"),
      ];

      const result = mapRender(reports, [], { filter: { pathsUnder: "C:\\workspace" } });

      expect(result.graph.summary.envCount).toBe(1);
    });

    it("filters by finding codes", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "SSL_BROKEN", severity: "bad", penalty: 40, what: "ssl", why: "why", fix: [] }],
        }),
        makeReport("C:\\p2\\.venv\\Scripts\\python.exe", { findings: [] }),
      ];

      const result = mapRender(reports, [], { filter: { codes: ["SSL_BROKEN"] } });

      expect(result.graph.summary.envCount).toBe(1);
    });
  });

  describe("mermaid output", () => {
    it("generates mermaid diagram when format includes mermaid", () => {
      const reports = [makeReport("C:\\project\\.venv\\Scripts\\python.exe")];

      const result = mapRender(reports, [], { format: "both" });

      expect(result.mermaid).toBeDefined();
      expect(result.mermaid).toContain("graph TD");
      expect(result.mermaid).toContain("classDef good");
    });

    it("omits mermaid when format is json only", () => {
      const reports = [makeReport("C:\\project\\.venv\\Scripts\\python.exe")];

      const result = mapRender(reports, [], { format: "json" });

      expect(result.mermaid).toBeUndefined();
    });

    it("includes hot edge labels with dominant issue emoji", () => {
      const reports = [
        makeReport("C:\\p1\\.venv\\Scripts\\python.exe", {
          findings: [{ code: "DLL_LOAD_FAIL", severity: "bad", penalty: 55, what: "dll", why: "why", fix: [] }],
        }),
      ];

      const result = mapRender(reports, [], { includeHotEdgeLabels: true });

      expect(result.mermaid).toContain("DLL_LOAD_FAIL");
      expect(result.mermaid).toContain("🧩"); // emoji for DLL_LOAD_FAIL
    });

    it("includes legend node", () => {
      const reports = [makeReport("C:\\project\\.venv\\Scripts\\python.exe")];

      const result = mapRender(reports, []);

      expect(result.mermaid).toContain("legend");
      expect(result.mermaid).toContain("Legend");
    });
  });

  describe("task nodes and edges", () => {
    function makeRunEvent(
      overrides: Partial<RunLogEventV1> & {
        taskName?: string;
        pythonPath?: string;
        ok?: boolean;
        errorClass?: string;
      } = {}
    ): RunLogEventV1 {
      return {
        version: "1.0",
        runId: overrides.runId ?? `run_${Math.random().toString(36).slice(2, 10)}`,
        at: overrides.at ?? "2024-01-01T12:00:00Z",
        cwd: overrides.cwd ?? "C:\\repo",
        task: overrides.task ?? {
          name: overrides.taskName ?? "pytest",
          command: "pytest tests/",
          args: ["tests/"],
          requirements: {
            packages: ["pytest"],
            tags: ["test"],
          },
        },
        selected: overrides.selected ?? {
          pythonPath: overrides.pythonPath ?? "C:\\repo\\.venv\\Scripts\\python.exe",
          score: 95,
          status: "good",
        },
        outcome: overrides.outcome ?? {
          ok: overrides.ok ?? true,
          exitCode: overrides.ok === false ? 1 : 0,
          durationMs: 1500,
          errorClass: overrides.ok === false ? (overrides.errorClass ?? "RUNTIME_ERROR") : undefined,
        },
        doctor: overrides.doctor,
      };
    }

    it("creates task nodes from run logs", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ taskName: "pytest", pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" }),
        makeRunEvent({ taskName: "lint", pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" }),
      ];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      expect(result.graph.summary.taskCount).toBe(2);
      expect(result.graph.nodes.filter((n) => n.type === "task")).toHaveLength(2);
    });

    it("creates ROUTES_TASK_TO edges from task to env", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [makeRunEvent({ taskName: "pytest", ok: true })];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      const routeEdges = result.graph.edges.filter((e) => e.type === "ROUTES_TASK_TO");
      expect(routeEdges).toHaveLength(1);
      expect(routeEdges[0]?.from).toContain("task:");
      expect(routeEdges[0]?.to).toContain("env:");
    });

    it("creates FAILED_RUN edges for failed tasks", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [makeRunEvent({ ok: false, errorClass: "SSL_BROKEN" })];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      const failEdges = result.graph.edges.filter((e) => e.type === "FAILED_RUN");
      expect(failEdges).toHaveLength(1);
      expect(failEdges[0]?.label).toContain("SSL_BROKEN");
      expect(failEdges[0]?.label).toContain("🔒"); // emoji
    });

    it("counts passed and failed runs in summary", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: false }),
      ];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      expect(result.graph.summary.runsPassed).toBe(2);
      expect(result.graph.summary.runsFailed).toBe(1);
    });

    it("creates env node for unknown python path from runs", () => {
      const reports: DoctorLiteReport[] = [];
      const runs = [makeRunEvent({ pythonPath: "C:\\unknown\\.venv\\Scripts\\python.exe" })];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      // Should still create an env node with "unknown" health
      expect(result.graph.nodes.filter((n) => n.type === "venv")).toHaveLength(1);
      expect(result.graph.nodes.find((n) => n.type === "venv")?.health?.status).toBe("good"); // from run.selected.status
    });

    it("uses doctor dominant issue from run if available", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs: RunLogEventV1[] = [
        {
          version: "1.0",
          runId: "run_abc123",
          at: "2024-01-01T12:00:00Z",
          task: { name: "train", command: "python train.py" },
          selected: { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe", status: "good" },
          outcome: { ok: false, exitCode: 1, errorClass: "RUNTIME_ERROR" },
          doctor: { dominantIssue: "DLL_LOAD_FAIL", findings: ["DLL_LOAD_FAIL", "SSL_BROKEN"] },
        },
      ];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      const failEdge = result.graph.edges.find((e) => e.type === "FAILED_RUN");
      // Should use doctor.dominantIssue over outcome.errorClass
      expect(failEdge?.label).toContain("DLL_LOAD_FAIL");
    });

    it("renders task edges in mermaid output", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [makeRunEvent({ ok: false, errorClass: "PIP_CHECK_FAIL" })];

      const result = mapRender(reports, runs, { format: "both", taskMode: "runs" });

      expect(result.mermaid).toContain("|routes|"); // ROUTES_TASK_TO label
      expect(result.mermaid).toContain("PIP_CHECK_FAIL");
      expect(result.mermaid).toContain("classDef task");
    });

    it("uses dashed edge style for FAILED_RUN in mermaid", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [makeRunEvent({ ok: false })];

      const result = mapRender(reports, runs, { format: "both", taskMode: "runs" });

      // Dashed edge format in mermaid
      expect(result.mermaid).toContain("-.->|");
    });
  });

  describe("clustered task mode", () => {
    function makeRunEvent(
      overrides: Partial<RunLogEventV1> & {
        taskName?: string;
        pythonPath?: string;
        ok?: boolean;
        errorClass?: string;
      } = {}
    ): RunLogEventV1 {
      return {
        version: "1.0",
        runId: overrides.runId ?? `run_${Math.random().toString(36).slice(2, 10)}`,
        at: overrides.at ?? "2024-01-01T12:00:00Z",
        cwd: overrides.cwd ?? "C:\\repo",
        task: overrides.task ?? {
          name: overrides.taskName ?? "pytest",
          command: "pytest tests/",
          args: ["tests/"],
          requirements: {
            packages: ["pytest"],
            tags: ["test"],
          },
        },
        selected: overrides.selected ?? {
          pythonPath: overrides.pythonPath ?? "C:\\repo\\.venv\\Scripts\\python.exe",
          score: 95,
          status: "good",
        },
        outcome: overrides.outcome ?? {
          ok: overrides.ok ?? true,
          exitCode: overrides.ok === false ? 1 : 0,
          durationMs: 1500,
          errorClass: overrides.ok === false ? (overrides.errorClass ?? "RUNTIME_ERROR") : undefined,
        },
        doctor: overrides.doctor,
      };
    }

    it("clusters multiple runs of same task into one node (default mode)", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: false }),
      ];

      const result = mapRender(reports, runs); // default taskMode is "clustered"

      // Should have only ONE task node for "pytest" (clustered), not 3
      const taskNodes = result.graph.nodes.filter((n) => n.type === "task");
      expect(taskNodes).toHaveLength(1);
      expect(taskNodes[0]?.caps?.features).toContain("runs:3");
      expect(taskNodes[0]?.caps?.features).toContain("ok:2");
      expect(taskNodes[0]?.caps?.features).toContain("fail:1");
    });

    it("creates weighted edges with counts in clustered mode", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: false }),
      ];

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const routeEdges = result.graph.edges.filter((e) => e.type === "ROUTES_TASK_TO");
      expect(routeEdges).toHaveLength(1);
      expect(routeEdges[0]?.weight).toBe(3); // 3 runs
      expect(routeEdges[0]?.label).toContain("x3");

      const failEdges = result.graph.edges.filter((e) => e.type === "FAILED_RUN");
      expect(failEdges).toHaveLength(1);
      expect(failEdges[0]?.weight).toBe(1); // 1 failure
    });

    it("tracks flaky status in clustered task node", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      // 60% success rate is flaky (between 20% and 95%)
      const runs = [
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: false }),
        makeRunEvent({ ok: false }),
      ];

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const taskNode = result.graph.nodes.find((n) => n.type === "task");
      expect(taskNode?.caps?.features).toContain("flaky:true");
      expect(taskNode?.health?.status).toBe("warn"); // mixed results
    });

    it("tracks env-flaky status when task fails on some envs only", () => {
      const reports = [
        makeReport("C:\\env1\\python.exe"),
        makeReport("C:\\env2\\python.exe"),
      ];
      const runs = [
        makeRunEvent({ pythonPath: "C:\\env1\\python.exe", ok: true }),
        makeRunEvent({ pythonPath: "C:\\env1\\python.exe", ok: true }),
        makeRunEvent({ pythonPath: "C:\\env2\\python.exe", ok: false }),
        makeRunEvent({ pythonPath: "C:\\env2\\python.exe", ok: false }),
      ];

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const taskNode = result.graph.nodes.find((n) => n.type === "task");
      expect(taskNode?.caps?.features).toContain("env-flaky:true");
    });

    it("groups different tasks separately", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "lint", ok: true }),
      ];

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const taskNodes = result.graph.nodes.filter((n) => n.type === "task");
      expect(taskNodes).toHaveLength(2);

      const pytestNode = taskNodes.find((n) => n.label === "pytest");
      const lintNode = taskNodes.find((n) => n.label === "lint");
      expect(pytestNode?.caps?.features).toContain("runs:2");
      expect(lintNode?.caps?.features).toContain("runs:1");
    });

    it("taskMode none disables task nodes entirely", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [makeRunEvent({ ok: true })];

      const result = mapRender(reports, runs, { taskMode: "none" });

      expect(result.graph.nodes.filter((n) => n.type === "task")).toHaveLength(0);
      expect(result.graph.edges.filter((e) => e.type === "ROUTES_TASK_TO")).toHaveLength(0);
    });

    it("taskMode runs creates one node per run (legacy behavior)", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      const runs = [
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: false }),
      ];

      const result = mapRender(reports, runs, { taskMode: "runs" });

      // Should have TWO task nodes (one per run)
      const taskNodes = result.graph.nodes.filter((n) => n.type === "task");
      expect(taskNodes).toHaveLength(2);
    });

    it("generates flaky task insight when cluster is flaky", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      // 60% success rate triggers flaky detection
      const runs = Array.from({ length: 10 }, (_, i) =>
        makeRunEvent({
          ok: i < 6, // 6 pass, 4 fail = 60%
          errorClass: "SSL_BROKEN",
        })
      );

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const flakyInsight = result.insights.find((i) => i.text.includes("Flaky task"));
      expect(flakyInsight).toBeDefined();
      expect(flakyInsight?.severity).toBe("high");
      expect(flakyInsight?.text).toContain("60%");
    });

    it("generates failure hotspot insight for env with many failures", () => {
      const reports = [makeReport("C:\\bad-env\\.venv\\Scripts\\python.exe")];
      // 5 failures on same env
      const runs = Array.from({ length: 5 }, () =>
        makeRunEvent({
          pythonPath: "C:\\bad-env\\.venv\\Scripts\\python.exe",
          ok: false,
          errorClass: "DLL_LOAD_FAIL",
        })
      );

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const hotspotInsight = result.insights.find((i) => i.text.includes("Failure hotspot"));
      expect(hotspotInsight).toBeDefined();
      expect(hotspotInsight?.severity).toBe("high");
    });

    it("generates contagion insight when most failures share same cause", () => {
      const reports = [makeReport("C:\\repo\\.venv\\Scripts\\python.exe")];
      // 8 failures, all SSL_BROKEN
      const runs = Array.from({ length: 10 }, (_, i) =>
        makeRunEvent({
          ok: i < 2, // 2 pass, 8 fail
          errorClass: "SSL_BROKEN",
        })
      );

      const result = mapRender(reports, runs, { taskMode: "clustered" });

      const contagionInsight = result.insights.find((i) => i.text.includes("same root cause"));
      expect(contagionInsight).toBeDefined();
      expect(contagionInsight?.text).toContain("SSL_BROKEN");
    });
  });
});
