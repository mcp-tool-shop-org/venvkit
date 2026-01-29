// integration.test.ts
// End-to-end integration tests for venvkit workflow

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { scanEnvPaths } from "./scanEnvPaths.js";
import { mapRender } from "./mapRender.js";
import { appendRunLog, readRunLog, summarizeRuns } from "./runLog.js";
import { clusterRuns, summarizeClusters } from "./taskCluster.js";
import type { DoctorLiteReport } from "./doctorLite.js";
import type { RunLogEventV1 } from "./runLog.js";

describe("integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-integration-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a mock venv structure
  async function createMockVenv(venvPath: string) {
    await fs.mkdir(venvPath, { recursive: true });
    await fs.writeFile(
      path.join(venvPath, "pyvenv.cfg"),
      "home = C:\\Python311\nversion = 3.11.5\n"
    );

    const binDir = os.platform() === "win32" ? "Scripts" : "bin";
    const pyExe = os.platform() === "win32" ? "python.exe" : "python";

    await fs.mkdir(path.join(venvPath, binDir), { recursive: true });
    await fs.writeFile(path.join(venvPath, binDir, pyExe), "fake python");

    return path.join(venvPath, binDir, pyExe);
  }

  // Helper to create mock doctor report
  function makeReport(
    pythonPath: string,
    opts: {
      status?: "good" | "warn" | "bad";
      score?: number;
      findings?: DoctorLiteReport["findings"];
      basePrefix?: string;
    } = {}
  ): DoctorLiteReport {
    return {
      pythonPath,
      ranAt: new Date().toISOString(),
      status: opts.status ?? "good",
      score: opts.score ?? 100,
      summary: "Test report",
      facts: {
        version: "3.11.5 (main)",
        version_info: [3, 11, 5],
        executable: pythonPath,
        prefix: pythonPath.replace(/[/\\](Scripts|bin)[/\\]python(\.exe)?$/, ""),
        base_prefix: opts.basePrefix ?? "C:\\Python311",
        bits: 64,
        machine: "AMD64",
        os: "windows",
        py_path: [],
        enable_user_site: false,
        user_site: "",
      },
      findings: opts.findings ?? [],
    };
  }

  // Helper to create run event
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
      runId: `run_${Math.random().toString(36).slice(2, 10)}`,
      at: overrides.at ?? new Date().toISOString(),
      cwd: tempDir,
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

  describe("scan and doctor workflow", () => {
    it("scans for venvs and creates doctor reports", async () => {
      // Step 1: Create venvs
      const py1 = await createMockVenv(path.join(tempDir, "project1", ".venv"));
      const py2 = await createMockVenv(path.join(tempDir, "project2", ".venv"));

      // Step 2: Scan for venvs
      const scanResult = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      // Should find our mock venvs
      expect(scanResult.meta.foundVenvs).toBeGreaterThanOrEqual(2);

      // Step 3: Create mock doctor reports (in real usage, would run doctorLite)
      const reports = [
        makeReport(py1, { status: "good", score: 100 }),
        makeReport(py2, { status: "warn", score: 70 }),
      ];

      // Step 4: Render graph
      const renderResult = mapRender(reports, [], { format: "both" });

      expect(renderResult.graph.summary.envCount).toBe(2);
      expect(renderResult.graph.summary.healthy).toBe(1);
      expect(renderResult.graph.summary.warning).toBe(1);
      expect(renderResult.mermaid).toContain("graph TD");
    });
  });

  describe("task clustering workflow", () => {
    it("logs tasks, clusters them, and generates insights", async () => {
      const logPath = path.join(tempDir, "runs.jsonl");

      // Step 1: Log multiple task runs
      const events = [
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: false, errorClass: "IMPORT_ERROR" }),
        makeRunEvent({ taskName: "lint", ok: true }),
        makeRunEvent({ taskName: "lint", ok: true }),
        makeRunEvent({ taskName: "build", ok: false, errorClass: "SSL_BROKEN" }),
      ];

      for (const evt of events) {
        await appendRunLog(logPath, evt);
      }

      // Step 2: Read run log
      const runs = await readRunLog(logPath);
      expect(runs).toHaveLength(6);

      // Step 3: Cluster runs
      const clusters = clusterRuns(runs);
      expect(clusters.length).toBe(3); // pytest, lint, build

      const pytestCluster = clusters.find((c) => c.sig.name === "pytest");
      expect(pytestCluster?.runs).toBe(3);
      expect(pytestCluster?.ok).toBe(2);
      expect(pytestCluster?.fail).toBe(1);

      // Step 4: Get summary
      const summary = summarizeClusters(clusters);
      expect(summary.totalTasks).toBe(3);
      expect(summary.totalRuns).toBe(6);
      expect(summary.totalOk).toBe(4);
      expect(summary.totalFail).toBe(2);
    });
  });

  describe("full graph rendering workflow", () => {
    it("combines doctor reports and task runs into unified graph", async () => {
      const logPath = path.join(tempDir, "runs.jsonl");

      // Step 1: Create mock envs and doctor reports
      const py1 = "C:\\project1\\.venv\\Scripts\\python.exe";
      const py2 = "C:\\project2\\.venv\\Scripts\\python.exe";

      const reports = [
        makeReport(py1, { status: "good", score: 95, basePrefix: "C:\\Python311" }),
        makeReport(py2, { status: "bad", score: 30, basePrefix: "C:\\Python311", findings: [
          { code: "SSL_BROKEN", severity: "bad", penalty: 40, what: "ssl", why: "why", fix: [] },
        ]}),
      ];

      // Step 2: Log task runs against these envs
      const events = [
        makeRunEvent({ taskName: "pytest", pythonPath: py1, ok: true }),
        makeRunEvent({ taskName: "pytest", pythonPath: py1, ok: true }),
        makeRunEvent({ taskName: "pytest", pythonPath: py2, ok: false, errorClass: "SSL_BROKEN" }),
        makeRunEvent({ taskName: "pytest", pythonPath: py2, ok: false, errorClass: "SSL_BROKEN" }),
      ];

      for (const evt of events) {
        await appendRunLog(logPath, evt);
      }

      const runs = await readRunLog(logPath);

      // Step 3: Render combined graph
      const result = mapRender(reports, runs, {
        format: "both",
        taskMode: "clustered",
        includeHotEdgeLabels: true,
      });

      // Verify graph structure
      expect(result.graph.summary.envCount).toBe(2);
      expect(result.graph.summary.taskCount).toBe(1); // 1 clustered pytest task

      // Verify insights
      expect(result.insights.length).toBeGreaterThan(0);

      // Verify mermaid output
      expect(result.mermaid).toContain("graph TD");
      expect(result.mermaid).toContain("pytest");
    });
  });

  describe("workflow with logging", () => {
    it("tracks task execution lifecycle through logging", async () => {
      const logPath = path.join(tempDir, "lifecycle.jsonl");

      // Simulate a development session with multiple task runs

      // Session 1: Initial development
      const session1Events = [
        makeRunEvent({ taskName: "lint", ok: true, at: "2024-01-01T10:00:00Z" }),
        makeRunEvent({ taskName: "test", ok: true, at: "2024-01-01T10:01:00Z" }),
        makeRunEvent({ taskName: "build", ok: true, at: "2024-01-01T10:02:00Z" }),
      ];

      for (const evt of session1Events) {
        await appendRunLog(logPath, evt);
      }

      // Session 2: Bug introduced
      const session2Events = [
        makeRunEvent({ taskName: "lint", ok: true, at: "2024-01-02T10:00:00Z" }),
        makeRunEvent({ taskName: "test", ok: false, errorClass: "RUNTIME_ERROR", at: "2024-01-02T10:01:00Z" }),
        makeRunEvent({ taskName: "build", ok: false, errorClass: "BUILD_FAIL", at: "2024-01-02T10:02:00Z" }),
      ];

      for (const evt of session2Events) {
        await appendRunLog(logPath, evt);
      }

      // Read all logs
      const runs = await readRunLog(logPath);
      expect(runs).toHaveLength(6);

      // Summarize
      const summary = summarizeRuns(runs);
      expect(summary.total).toBe(6);
      expect(summary.passed).toBe(4);
      expect(summary.failed).toBe(2);

      // Task-level summary
      expect(summary.byTask.get("lint")).toEqual({ passed: 2, failed: 0 });
      expect(summary.byTask.get("test")).toEqual({ passed: 1, failed: 1 });
      expect(summary.byTask.get("build")).toEqual({ passed: 1, failed: 1 });
    });
  });

  describe("CLI integration", () => {
    it("produces all expected output files", async () => {
      // This test verifies the expected output structure from CLI
      // without actually running the CLI (which would require real Python envs)

      const outDir = path.join(tempDir, "output");
      await fs.mkdir(outDir, { recursive: true });

      // Create mock outputs as CLI would
      const reports = [makeReport("C:\\project\\.venv\\Scripts\\python.exe")];
      const result = mapRender(reports, [], { format: "both" });

      // Write outputs as CLI would
      await fs.writeFile(
        path.join(outDir, "venv-map.json"),
        JSON.stringify(result.graph, null, 2)
      );
      await fs.writeFile(path.join(outDir, "venv-map.mmd"), result.mermaid ?? "");
      await fs.writeFile(path.join(outDir, "reports.json"), JSON.stringify(reports, null, 2));
      await fs.writeFile(path.join(outDir, "insights.json"), JSON.stringify(result.insights, null, 2));

      // Verify all files exist
      const files = await fs.readdir(outDir);
      expect(files).toContain("venv-map.json");
      expect(files).toContain("venv-map.mmd");
      expect(files).toContain("reports.json");
      expect(files).toContain("insights.json");

      // Verify JSON is valid
      const graphJson = JSON.parse(await fs.readFile(path.join(outDir, "venv-map.json"), "utf8"));
      expect(graphJson.summary).toBeDefined();
      expect(graphJson.nodes).toBeDefined();
      expect(graphJson.edges).toBeDefined();
    });
  });
});
