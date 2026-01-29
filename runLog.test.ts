// runLog.test.ts
// Unit tests for run log append + read

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  newRunId,
  appendRunLog,
  readRunLog,
  summarizeRuns,
  type RunLogEventV1,
} from "./runLog.js";

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
    runId: overrides.runId ?? newRunId(),
    at: overrides.at ?? new Date().toISOString(),
    cwd: overrides.cwd ?? "/repo",
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
      stderrSnippet: overrides.ok === false ? "AssertionError: expected true" : undefined,
    },
    doctor: overrides.doctor,
  };
}

describe("runLog", () => {
  describe("newRunId", () => {
    it("generates UUID when no input provided", () => {
      const id1 = newRunId();
      const id2 = newRunId();

      expect(id1).not.toBe(id2);
      // UUID format
      expect(id1).toMatch(/^[\da-f-]{36}$/i);
    });

    it("generates deterministic ID from input", () => {
      const id1 = newRunId("pytest|pytest tests/|2024-01-01");
      const id2 = newRunId("pytest|pytest tests/|2024-01-01");

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^run_[\da-f]{16}$/);
    });

    it("different inputs produce different IDs", () => {
      const id1 = newRunId("task1");
      const id2 = newRunId("task2");

      expect(id1).not.toBe(id2);
    });
  });

  describe("appendRunLog + readRunLog", () => {
    let tempDir: string;
    let logPath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-test-"));
      logPath = path.join(tempDir, "runs.jsonl");
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("appends and reads a single event", async () => {
      const evt = makeRunEvent({ taskName: "lint" });
      await appendRunLog(logPath, evt);

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.task.name).toBe("lint");
      expect(runs[0]?.version).toBe("1.0");
    });

    it("appends multiple events", async () => {
      await appendRunLog(logPath, makeRunEvent({ taskName: "test1" }));
      await appendRunLog(logPath, makeRunEvent({ taskName: "test2" }));
      await appendRunLog(logPath, makeRunEvent({ taskName: "test3" }));

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(3);
      expect(runs.map((r) => r.task.name)).toEqual(["test1", "test2", "test3"]);
    });

    it("returns empty array for missing file", async () => {
      const runs = await readRunLog(path.join(tempDir, "nonexistent.jsonl"));

      expect(runs).toEqual([]);
    });

    it("skips malformed lines gracefully", async () => {
      // Write valid + invalid lines
      await fs.writeFile(
        logPath,
        [
          JSON.stringify(makeRunEvent({ taskName: "valid1" })),
          "{ broken json",
          "",
          JSON.stringify(makeRunEvent({ taskName: "valid2" })),
          '{"version": "0.9", "old": true}', // wrong version
        ].join("\n"),
        "utf8"
      );

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.task.name)).toEqual(["valid1", "valid2"]);
    });

    it("respects maxLines option", async () => {
      for (let i = 0; i < 10; i++) {
        await appendRunLog(logPath, makeRunEvent({ taskName: `task${i}` }));
      }

      const runs = await readRunLog(logPath, { maxLines: 3 });

      expect(runs).toHaveLength(3);
      // Should be last 3 lines
      expect(runs.map((r) => r.task.name)).toEqual(["task7", "task8", "task9"]);
    });

    it("creates parent directories if needed", async () => {
      const nestedPath = path.join(tempDir, "deep", "nested", "dir", "runs.jsonl");
      await appendRunLog(nestedPath, makeRunEvent({ taskName: "nested" }));

      const runs = await readRunLog(nestedPath);
      expect(runs).toHaveLength(1);
    });
  });

  describe("summarizeRuns", () => {
    it("counts passed and failed runs", () => {
      const runs = [
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: true }),
        makeRunEvent({ ok: false }),
      ];

      const summary = summarizeRuns(runs);

      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
    });

    it("groups by task name", () => {
      const runs = [
        makeRunEvent({ taskName: "pytest", ok: true }),
        makeRunEvent({ taskName: "pytest", ok: false }),
        makeRunEvent({ taskName: "lint", ok: true }),
      ];

      const summary = summarizeRuns(runs);

      expect(summary.byTask.get("pytest")).toEqual({ passed: 1, failed: 1 });
      expect(summary.byTask.get("lint")).toEqual({ passed: 1, failed: 0 });
    });

    it("groups by env path", () => {
      const runs = [
        makeRunEvent({ pythonPath: "C:\\env1\\python.exe", ok: true }),
        makeRunEvent({ pythonPath: "C:\\env1\\python.exe", ok: false }),
        makeRunEvent({ pythonPath: "C:\\env2\\python.exe", ok: true }),
      ];

      const summary = summarizeRuns(runs);

      expect(summary.byEnv.get("C:\\env1\\python.exe")).toEqual({ passed: 1, failed: 1 });
      expect(summary.byEnv.get("C:\\env2\\python.exe")).toEqual({ passed: 1, failed: 0 });
    });

    it("handles empty array", () => {
      const summary = summarizeRuns([]);

      expect(summary.total).toBe(0);
      expect(summary.passed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.byTask.size).toBe(0);
      expect(summary.byEnv.size).toBe(0);
    });
  });

  describe("task lifecycle logging", () => {
    let tempDir: string;
    let logPath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-lifecycle-"));
      logPath = path.join(tempDir, "lifecycle.jsonl");
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("records task start with timestamp", async () => {
      const startTime = new Date().toISOString();
      const evt = makeRunEvent({
        at: startTime,
        taskName: "pytest",
        ok: true,
      });

      await appendRunLog(logPath, evt);
      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.at).toBe(startTime);
      expect(runs[0]?.task.name).toBe("pytest");
    });

    it("records task completion with exit code", async () => {
      const evt = makeRunEvent({
        ok: true,
        outcome: { ok: true, exitCode: 0, durationMs: 1234 },
      });

      await appendRunLog(logPath, evt);
      const runs = await readRunLog(logPath);

      expect(runs[0]?.outcome.ok).toBe(true);
      expect(runs[0]?.outcome.exitCode).toBe(0);
      expect(runs[0]?.outcome.durationMs).toBe(1234);
    });

    it("records task failure with error class", async () => {
      const evt = makeRunEvent({
        ok: false,
        errorClass: "SSL_BROKEN",
      });

      await appendRunLog(logPath, evt);
      const runs = await readRunLog(logPath);

      expect(runs[0]?.outcome.ok).toBe(false);
      expect(runs[0]?.outcome.errorClass).toBe("SSL_BROKEN");
    });

    it("records task failure with stderr snippet", async () => {
      const evt: RunLogEventV1 = {
        ...makeRunEvent({ ok: false }),
        outcome: {
          ok: false,
          exitCode: 1,
          errorClass: "IMPORT_ERROR",
          stderrSnippet: "ModuleNotFoundError: No module named 'torch'",
        },
      };

      await appendRunLog(logPath, evt);
      const runs = await readRunLog(logPath);

      expect(runs[0]?.outcome.stderrSnippet).toContain("ModuleNotFoundError");
    });
  });

  describe("concurrent task handling", () => {
    let tempDir: string;
    let logPath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-concurrent-"));
      logPath = path.join(tempDir, "concurrent.jsonl");
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("handles concurrent appends from multiple tasks", async () => {
      // Simulate multiple concurrent task completions
      const events = Array.from({ length: 10 }, (_, i) =>
        makeRunEvent({ taskName: `task${i}`, runId: `run_concurrent_${i}` })
      );

      // Append all concurrently
      await Promise.all(events.map((evt) => appendRunLog(logPath, evt)));

      const runs = await readRunLog(logPath);

      // All events should be recorded
      expect(runs).toHaveLength(10);
      const runIds = runs.map((r) => r.runId);
      events.forEach((evt) => {
        expect(runIds).toContain(evt.runId);
      });
    });

    it("maintains event order within single task", async () => {
      // Write sequentially to maintain order
      for (let i = 0; i < 5; i++) {
        await appendRunLog(
          logPath,
          makeRunEvent({ taskName: "sequential", runId: `run_seq_${i}` })
        );
      }

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(runs[i]?.runId).toBe(`run_seq_${i}`);
      }
    });
  });

  describe("log persistence and retrieval", () => {
    let tempDir: string;
    let logPath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-persist-"));
      logPath = path.join(tempDir, "persist.jsonl");
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("persists events across sessions", async () => {
      // Session 1: write events
      await appendRunLog(logPath, makeRunEvent({ taskName: "session1", runId: "run_s1" }));
      await appendRunLog(logPath, makeRunEvent({ taskName: "session1", runId: "run_s2" }));

      // Session 2: read and write more
      const initialRuns = await readRunLog(logPath);
      expect(initialRuns).toHaveLength(2);

      await appendRunLog(logPath, makeRunEvent({ taskName: "session2", runId: "run_s3" }));

      // Session 3: verify all present
      const finalRuns = await readRunLog(logPath);
      expect(finalRuns).toHaveLength(3);
      expect(finalRuns.map((r) => r.runId)).toEqual(["run_s1", "run_s2", "run_s3"]);
    });

    it("retrieves runs by various criteria", async () => {
      await appendRunLog(logPath, makeRunEvent({ taskName: "pytest", ok: true }));
      await appendRunLog(logPath, makeRunEvent({ taskName: "pytest", ok: false }));
      await appendRunLog(logPath, makeRunEvent({ taskName: "lint", ok: true }));

      const runs = await readRunLog(logPath);
      const summary = summarizeRuns(runs);

      // Can filter by task
      expect(summary.byTask.get("pytest")).toEqual({ passed: 1, failed: 1 });
      expect(summary.byTask.get("lint")).toEqual({ passed: 1, failed: 0 });
    });
  });

  describe("log file operations", () => {
    let tempDir: string;
    let logPath: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-ops-"));
      logPath = path.join(tempDir, "ops.jsonl");
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("handles log file with only newlines", async () => {
      await fs.writeFile(logPath, "\n\n\n", "utf8");

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(0);
    });

    it("handles very large events", async () => {
      const largeStderr = "x".repeat(10000);
      const evt: RunLogEventV1 = {
        ...makeRunEvent({ ok: false }),
        outcome: {
          ok: false,
          exitCode: 1,
          stderrSnippet: largeStderr,
        },
      };

      await appendRunLog(logPath, evt);
      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.outcome.stderrSnippet).toBe(largeStderr);
    });

    it("clears log by overwriting", async () => {
      await appendRunLog(logPath, makeRunEvent({ runId: "run_1" }));
      await appendRunLog(logPath, makeRunEvent({ runId: "run_2" }));

      // Clear by overwriting with empty content
      await fs.writeFile(logPath, "", "utf8");

      const runs = await readRunLog(logPath);

      expect(runs).toHaveLength(0);
    });
  });
});
