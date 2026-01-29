// scanEnvPaths.test.ts
// Unit tests for environment path discovery

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { scanEnvPaths, type ScanOptions, type ScanResult } from "./scanEnvPaths.js";

describe("scanEnvPaths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venvkit-scan-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a mock venv structure
  async function createMockVenv(venvPath: string) {
    await fs.mkdir(venvPath, { recursive: true });
    await fs.writeFile(path.join(venvPath, "pyvenv.cfg"), "home = C:\\Python311\nversion = 3.11.5\n");

    const binDir = os.platform() === "win32" ? "Scripts" : "bin";
    const pyExe = os.platform() === "win32" ? "python.exe" : "python";

    await fs.mkdir(path.join(venvPath, binDir), { recursive: true });
    await fs.writeFile(path.join(venvPath, binDir, pyExe), "fake python");

    return path.join(venvPath, binDir, pyExe);
  }

  describe("finding Python venvs", () => {
    it("finds venv with pyvenv.cfg", async () => {
      const venvPath = path.join(tempDir, "project", ".venv");
      await createMockVenv(venvPath);

      const result = await scanEnvPaths({
        roots: [path.join(tempDir, "project")],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result.pythonPaths.length).toBeGreaterThanOrEqual(1);
      expect(result.meta.foundVenvs).toBeGreaterThanOrEqual(1);
    });

    it("finds multiple venvs in project tree", async () => {
      await createMockVenv(path.join(tempDir, "project1", ".venv"));
      await createMockVenv(path.join(tempDir, "project2", "venv"));
      await createMockVenv(path.join(tempDir, "project3", "env"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result.meta.foundVenvs).toBeGreaterThanOrEqual(3);
    });

    it("finds venv in standard project locations", async () => {
      // Test standard venv folder names: .venv, venv, env
      const projectRoot = path.join(tempDir, "myproject");
      await fs.mkdir(projectRoot, { recursive: true });

      const venvPath = path.join(projectRoot, ".venv");
      await createMockVenv(venvPath);

      const result = await scanEnvPaths({
        roots: [projectRoot],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result.pythonPaths.some(p => p.includes(".venv"))).toBe(true);
    });
  });

  describe("scan options", () => {
    it("respects maxDepth limit", async () => {
      // Create venv at depth 2
      await createMockVenv(path.join(tempDir, "level1", ".venv"));
      // Create venv at depth 4 (should not be found with maxDepth=2)
      await createMockVenv(path.join(tempDir, "level1", "level2", "level3", ".venv"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 2,
        includeUserHomeCache: false,
      });

      // Should find shallow venv but not deeply nested one
      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundPaths.length).toBe(1);
    });

    it("ignores hidden directories by default", async () => {
      await createMockVenv(path.join(tempDir, ".hidden", "venv"));
      await createMockVenv(path.join(tempDir, "visible", "venv"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeHidden: false,
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundPaths.some(p => p.includes(".hidden"))).toBe(false);
      expect(foundPaths.some(p => p.includes("visible"))).toBe(true);
    });

    it("includes hidden directories when flag is set", async () => {
      await createMockVenv(path.join(tempDir, ".hidden", "venv"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeHidden: true,
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundPaths.some(p => p.includes(".hidden"))).toBe(true);
    });

    it("deduplicates paths by default", async () => {
      const venvPath = path.join(tempDir, "project", ".venv");
      await createMockVenv(venvPath);

      // Scan same root twice
      const result = await scanEnvPaths({
        roots: [path.join(tempDir, "project"), path.join(tempDir, "project")],
        maxDepth: 3,
        dedupe: true,
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      // Should only have one entry despite scanning same location twice
      expect(new Set(foundPaths).size).toBe(foundPaths.length);
    });
  });

  describe("handling edge cases", () => {
    it("handles empty directory", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir, { recursive: true });

      const result = await scanEnvPaths({
        roots: [emptyDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      const foundInTemp = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundInTemp.length).toBe(0);
    });

    it("handles permission errors gracefully", async () => {
      // This test might behave differently on Windows vs POSIX
      // The key is that it doesn't throw
      const result = await scanEnvPaths({
        roots: ["/nonexistent/path/that/should/not/exist"],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result).toBeDefined();
      expect(result.pythonPaths).toBeDefined();
    });

    it("skips node_modules directory", async () => {
      // Create a venv inside node_modules (should be skipped)
      await createMockVenv(path.join(tempDir, "node_modules", "some-pkg", ".venv"));
      await createMockVenv(path.join(tempDir, "src", ".venv"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 5,
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundPaths.some(p => p.includes("node_modules"))).toBe(false);
      expect(foundPaths.some(p => p.includes("src"))).toBe(true);
    });

    it("skips .git directory", async () => {
      await createMockVenv(path.join(tempDir, ".git", "hooks", ".venv"));
      await createMockVenv(path.join(tempDir, "app", ".venv"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 5,
        includeHidden: true, // Even with hidden enabled, .git should be skipped
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      expect(foundPaths.some(p => p.includes(".git"))).toBe(false);
    });

    it("handles venv without python executable", async () => {
      // Create pyvenv.cfg but no python executable
      const venvPath = path.join(tempDir, "broken-venv");
      await fs.mkdir(venvPath, { recursive: true });
      await fs.writeFile(path.join(venvPath, "pyvenv.cfg"), "home = C:\\Python311\n");
      // Deliberately don't create Scripts/python.exe

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      // Should not crash, and should not find the broken venv
      const foundBroken = result.pythonPaths.filter(p => p.includes("broken-venv"));
      expect(foundBroken.length).toBe(0);
    });
  });

  describe("meta information", () => {
    it("reports scanned roots in meta", async () => {
      const root1 = path.join(tempDir, "root1");
      const root2 = path.join(tempDir, "root2");
      await fs.mkdir(root1, { recursive: true });
      await fs.mkdir(root2, { recursive: true });

      const result = await scanEnvPaths({
        roots: [root1, root2],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result.meta.scannedRoots).toContain(root1);
      expect(result.meta.scannedRoots).toContain(root2);
      expect(result.meta.maxDepth).toBe(3);
    });

    it("counts venvs and bases separately", async () => {
      await createMockVenv(path.join(tempDir, "venv1"));
      await createMockVenv(path.join(tempDir, "venv2"));

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });

      expect(result.meta.foundVenvs).toBeGreaterThanOrEqual(2);
      expect(typeof result.meta.foundBases).toBe("number");
    });
  });

  describe("nested environment handling", () => {
    it("detects venv and does not descend further", async () => {
      // Create a venv with a nested venv inside (unusual but possible)
      const outerVenv = path.join(tempDir, "outer-venv");
      await createMockVenv(outerVenv);

      // Create another venv inside (should not be found because we stop at outer venv)
      const innerVenv = path.join(outerVenv, "nested", "inner-venv");
      await createMockVenv(innerVenv);

      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 10,
        includeUserHomeCache: false,
      });

      const foundPaths = result.pythonPaths.filter(p => p.includes(tempDir));
      const foundOuter = foundPaths.filter(p => p.includes("outer-venv") && !p.includes("inner-venv"));
      const foundInner = foundPaths.filter(p => p.includes("inner-venv"));

      // Should find outer venv
      expect(foundOuter.length).toBe(1);
      // Should NOT find inner venv (scan stops at venv boundary)
      expect(foundInner.length).toBe(0);
    });
  });

  describe("large directory trees", () => {
    it("handles directory with many subdirectories", async () => {
      // Create many directories to test performance doesn't degrade badly
      for (let i = 0; i < 20; i++) {
        await fs.mkdir(path.join(tempDir, `dir${i}`), { recursive: true });
      }
      await createMockVenv(path.join(tempDir, "dir10", ".venv"));

      const start = Date.now();
      const result = await scanEnvPaths({
        roots: [tempDir],
        maxDepth: 3,
        includeUserHomeCache: false,
      });
      const elapsed = Date.now() - start;

      expect(result.meta.foundVenvs).toBeGreaterThanOrEqual(1);
      // Should complete in reasonable time (less than 5 seconds)
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
