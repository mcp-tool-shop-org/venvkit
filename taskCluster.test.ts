// taskCluster.test.ts
// Unit tests for task signature clustering and flake detection

import { describe, it, expect } from "vitest";
import {
  signatureForRun,
  clusterRuns,
  isFlaky,
  isEnvDependentFlaky,
  getFailingEnvs,
  summarizeClusters,
  type TaskCluster,
} from "./taskCluster.js";
import type { RunLogEventV1 } from "./runLog.js";

function makeRun(
  overrides: Partial<RunLogEventV1> & {
    taskName?: string;
    command?: string;
    pythonPath?: string;
    ok?: boolean;
    errorClass?: string;
    packages?: string[];
  } = {}
): RunLogEventV1 {
  return {
    version: "1.0",
    runId: overrides.runId ?? `run_${Math.random().toString(36).slice(2, 10)}`,
    at: overrides.at ?? "2024-01-01T12:00:00Z",
    cwd: overrides.cwd ?? "C:\\repo",
    task: overrides.task ?? {
      name: overrides.taskName ?? "pytest",
      command: overrides.command ?? "pytest tests/",
      args: ["tests/"],
      requirements: {
        packages: overrides.packages ?? ["pytest"],
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

describe("taskCluster", () => {
  describe("signatureForRun", () => {
    it("generates stable signature for same task", () => {
      const run1 = makeRun({ taskName: "pytest", command: "pytest tests/" });
      const run2 = makeRun({ taskName: "pytest", command: "pytest tests/" });

      const sig1 = signatureForRun(run1);
      const sig2 = signatureForRun(run2);

      expect(sig1.sigId).toBe(sig2.sigId);
      expect(sig1.name).toBe("pytest");
    });

    it("generates different signatures for different tasks", () => {
      const run1 = makeRun({ taskName: "pytest", command: "pytest tests/" });
      const run2 = makeRun({ taskName: "lint", command: "ruff check ." });

      const sig1 = signatureForRun(run1);
      const sig2 = signatureForRun(run2);

      expect(sig1.sigId).not.toBe(sig2.sigId);
    });

    it("normalizes command whitespace", () => {
      const run1 = makeRun({ command: "pytest  tests/" });
      const run2 = makeRun({ command: "pytest tests/" });

      const sig1 = signatureForRun(run1);
      const sig2 = signatureForRun(run2);

      expect(sig1.sigId).toBe(sig2.sigId);
    });

    it("includes requirements in signature", () => {
      const run1 = makeRun({ packages: ["pytest", "torch"] });
      const run2 = makeRun({ packages: ["pytest"] });

      const sig1 = signatureForRun(run1);
      const sig2 = signatureForRun(run2);

      expect(sig1.sigId).not.toBe(sig2.sigId);
    });
  });

  describe("clusterRuns", () => {
    it("clusters runs by signature", () => {
      const runs = [
        makeRun({ taskName: "pytest", ok: true }),
        makeRun({ taskName: "pytest", ok: true }),
        makeRun({ taskName: "pytest", ok: false }),
        makeRun({ taskName: "lint", ok: true }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters).toHaveLength(2);

      const pytestCluster = clusters.find((c) => c.sig.name === "pytest");
      expect(pytestCluster?.runs).toBe(3);
      expect(pytestCluster?.ok).toBe(2);
      expect(pytestCluster?.fail).toBe(1);

      const lintCluster = clusters.find((c) => c.sig.name === "lint");
      expect(lintCluster?.runs).toBe(1);
      expect(lintCluster?.ok).toBe(1);
    });

    it("computes success rate correctly", () => {
      const runs = [
        makeRun({ ok: true }),
        makeRun({ ok: true }),
        makeRun({ ok: false }),
        makeRun({ ok: false }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters[0]?.successRate).toBe(0.5);
    });

    it("tracks failure codes", () => {
      const runs = [
        makeRun({ ok: false, errorClass: "SSL_BROKEN" }),
        makeRun({ ok: false, errorClass: "SSL_BROKEN" }),
        makeRun({ ok: false, errorClass: "DLL_LOAD_FAIL" }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters[0]?.failureCounts["SSL_BROKEN"]).toBe(2);
      expect(clusters[0]?.failureCounts["DLL_LOAD_FAIL"]).toBe(1);
      expect(clusters[0]?.dominantFailure).toBe("SSL_BROKEN");
    });

    it("tracks per-env counts", () => {
      const runs = [
        makeRun({ pythonPath: "C:\\env1\\python.exe", ok: true }),
        makeRun({ pythonPath: "C:\\env1\\python.exe", ok: false }),
        makeRun({ pythonPath: "C:\\env2\\python.exe", ok: true }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters[0]?.envCounts["C:\\env1\\python.exe"]).toBe(2);
      expect(clusters[0]?.envCounts["C:\\env2\\python.exe"]).toBe(1);
      expect(clusters[0]?.envFailCounts["C:\\env1\\python.exe"]).toBe(1);
      expect(clusters[0]?.envOkCounts["C:\\env2\\python.exe"]).toBe(1);
    });

    it("uses latest timestamp", () => {
      const runs = [
        makeRun({ at: "2024-01-01T12:00:00Z" }),
        makeRun({ at: "2024-01-05T12:00:00Z" }),
        makeRun({ at: "2024-01-03T12:00:00Z" }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters[0]?.lastAt).toBe("2024-01-05T12:00:00Z");
    });

    it("sorts clusters by run count descending", () => {
      const runs = [
        makeRun({ taskName: "rare" }),
        makeRun({ taskName: "common" }),
        makeRun({ taskName: "common" }),
        makeRun({ taskName: "common" }),
      ];

      const clusters = clusterRuns(runs);

      expect(clusters[0]?.sig.name).toBe("common");
      expect(clusters[1]?.sig.name).toBe("rare");
    });
  });

  describe("isFlaky", () => {
    it("returns false if all runs succeed", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 10,
        ok: 10,
        fail: 0,
        successRate: 1,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: {},
        envCounts: {},
        envFailCounts: {},
        envOkCounts: {},
      };

      expect(isFlaky(cluster)).toBe(false);
    });

    it("returns false if all runs fail", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 10,
        ok: 0,
        fail: 10,
        successRate: 0,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 10 },
        envCounts: {},
        envFailCounts: {},
        envOkCounts: {},
      };

      expect(isFlaky(cluster)).toBe(false);
    });

    it("returns true for mixed success/failure with moderate rate", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 10,
        ok: 6,
        fail: 4,
        successRate: 0.6,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 4 },
        envCounts: {},
        envFailCounts: {},
        envOkCounts: {},
      };

      expect(isFlaky(cluster)).toBe(true);
    });

    it("returns false if success rate too low (< 20%)", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 10,
        ok: 1,
        fail: 9,
        successRate: 0.1,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 9 },
        envCounts: {},
        envFailCounts: {},
        envOkCounts: {},
      };

      expect(isFlaky(cluster)).toBe(false);
    });
  });

  describe("isEnvDependentFlaky", () => {
    it("returns true when task succeeds on one env, fails on another", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 4,
        ok: 2,
        fail: 2,
        successRate: 0.5,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 2 },
        envCounts: { "env1": 2, "env2": 2 },
        envFailCounts: { "env2": 2 },
        envOkCounts: { "env1": 2 },
      };

      expect(isEnvDependentFlaky(cluster)).toBe(true);
    });

    it("returns false with only one env", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 4,
        ok: 2,
        fail: 2,
        successRate: 0.5,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 2 },
        envCounts: { "env1": 4 },
        envFailCounts: { "env1": 2 },
        envOkCounts: { "env1": 2 },
      };

      expect(isEnvDependentFlaky(cluster)).toBe(false);
    });
  });

  describe("getFailingEnvs", () => {
    it("returns envs sorted by fail count", () => {
      const cluster: TaskCluster = {
        sig: { sigId: "task_abc", name: "test", command: "test", requirementsKey: "" },
        runs: 10,
        ok: 5,
        fail: 5,
        successRate: 0.5,
        lastAt: "2024-01-01T12:00:00Z",
        failureCounts: { RUN_FAILED: 5 },
        envCounts: { "env1": 4, "env2": 4, "env3": 2 },
        envFailCounts: { "env1": 1, "env2": 3, "env3": 1 },
        envOkCounts: { "env1": 3, "env2": 1, "env3": 1 },
      };

      const failing = getFailingEnvs(cluster, 2);

      expect(failing).toHaveLength(2);
      expect(failing[0]?.pythonPath).toBe("env2");
      expect(failing[0]?.failCount).toBe(3);
      expect(failing[0]?.failRate).toBe(0.75);
    });
  });

  describe("summarizeClusters", () => {
    it("aggregates totals across clusters", () => {
      const clusters: TaskCluster[] = [
        {
          sig: { sigId: "task_1", name: "test1", command: "test", requirementsKey: "" },
          runs: 20,
          ok: 20,
          fail: 0,
          successRate: 1.0, // 100% success - NOT flaky
          lastAt: "2024-01-01T12:00:00Z",
          failureCounts: {},
          envCounts: {},
          envFailCounts: {},
          envOkCounts: {},
        },
        {
          sig: { sigId: "task_2", name: "test2", command: "test", requirementsKey: "" },
          runs: 5,
          ok: 3,
          fail: 2,
          successRate: 0.6, // 60% success - flaky (between 20% and 95%)
          lastAt: "2024-01-01T12:00:00Z",
          failureCounts: { SSL_BROKEN: 2 },
          envCounts: {},
          envFailCounts: {},
          envOkCounts: {},
        },
      ];

      const summary = summarizeClusters(clusters);

      expect(summary.totalTasks).toBe(2);
      expect(summary.totalRuns).toBe(25);
      expect(summary.totalOk).toBe(23);
      expect(summary.totalFail).toBe(2);
      expect(summary.overallSuccessRate).toBeCloseTo(23 / 25);
      expect(summary.flakyCount).toBe(1); // test2 is flaky (60% success)
    });
  });
});
