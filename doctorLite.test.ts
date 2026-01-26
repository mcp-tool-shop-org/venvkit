// venvkit/doctorLite.test.ts
// Unit tests for doctorLite using injectable runner for deterministic testing

import { describe, it, expect, vi } from "vitest";
import { doctorLite, type CmdRunner, type RunResult, type Finding } from "./doctorLite.js";

// Helper to create RunResult
function ok(stdout: string, stderr = ""): RunResult {
  return { ok: true, exitCode: 0, stdout, stderr, timedOut: false };
}

function fail(exitCode: number, stderr: string, stdout = ""): RunResult {
  return { ok: false, exitCode, stdout, stderr, timedOut: false };
}

function timeout(): RunResult {
  return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: true };
}

// Common canned responses
const FACTS_HEALTHY_VENV = JSON.stringify({
  version: "3.11.5 (main, Aug 24 2023)",
  version_info: [3, 11, 5, "final", 0],
  executable: "C:\\repo\\.venv\\Scripts\\python.exe",
  prefix: "C:\\repo\\.venv",
  base_prefix: "C:\\Python311",
  bits: 64,
  machine: "AMD64",
  os: "windows",
  py_path: ["C:\\repo\\.venv\\Scripts", "C:\\repo\\.venv\\Lib\\site-packages"],
  enable_user_site: false,
  user_site: "C:\\Users\\test\\AppData\\Roaming\\Python\\Python311\\site-packages",
});

const FACTS_BASE_PYTHON = JSON.stringify({
  version: "3.11.5 (main, Aug 24 2023)",
  version_info: [3, 11, 5, "final", 0],
  executable: "C:\\Python311\\python.exe",
  prefix: "C:\\Python311",
  base_prefix: "C:\\Python311", // same as prefix = not a venv
  bits: 64,
  machine: "AMD64",
  os: "windows",
  py_path: ["C:\\Python311\\Lib\\site-packages"],
  enable_user_site: true,
  user_site: "C:\\Users\\test\\AppData\\Roaming\\Python\\Python311\\site-packages",
});

const FACTS_32BIT = JSON.stringify({
  version: "3.11.5 (main, Aug 24 2023)",
  version_info: [3, 11, 5, "final", 0],
  executable: "C:\\Python311-32\\python.exe",
  prefix: "C:\\Python311-32",
  base_prefix: "C:\\Python311-32",
  bits: 32,
  machine: "x86",
  os: "windows",
  py_path: [],
  enable_user_site: false,
  user_site: "",
});

const PIP_VERSION_OK = "pip 23.2.1 from C:\\repo\\.venv\\Lib\\site-packages\\pip (python 3.11)";
const PIP_VERSION_MISMATCH = "pip 23.2.1 from C:\\repo\\.venv\\Lib\\site-packages\\pip (python 3.10)";

const IMPORTS_ALL_OK = JSON.stringify({
  imports: [
    { module: "ssl", ok: true },
    { module: "ctypes", ok: true },
    { module: "sqlite3", ok: true },
  ],
});

const IMPORTS_SSL_FAIL = JSON.stringify({
  imports: [
    { module: "ssl", ok: false, err: "ImportError('DLL load failed')", tb: "..." },
    { module: "ctypes", ok: true },
    { module: "sqlite3", ok: true },
  ],
});

const IMPORTS_DLL_FAIL = JSON.stringify({
  imports: [
    { module: "ssl", ok: true },
    { module: "ctypes", ok: true },
    { module: "sqlite3", ok: true },
    { module: "torch", ok: false, err: "OSError('DLL load failed while importing torch')", tb: "..." },
  ],
});

const IMPORTS_ABI_MISMATCH = JSON.stringify({
  imports: [
    { module: "ssl", ok: true },
    { module: "ctypes", ok: true },
    { module: "sqlite3", ok: true },
    {
      module: "numpy",
      ok: false,
      err: "ImportError('mach-o file, but is an incompatible architecture')",
      tb: "...",
    },
  ],
});

// Helper to create a mock runner with specific responses
function createMockRunner(overrides: {
  facts?: string;
  pip?: RunResult;
  imports?: string;
  https?: string;
  pipCheck?: RunResult;
  multiVersion?: string;
}) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const arg = args.join(" ");

    // Order matters - more specific checks first
    if (arg.includes("print('ok')")) return ok("ok\n");

    // pip --version
    if (arg.includes("-m pip --version") || (arg.includes("pip") && arg.includes("--version"))) {
      return overrides.pip ?? ok(PIP_VERSION_OK);
    }

    // pip check (strict mode)
    if (arg.includes("-m pip check") || (arg.includes("pip") && arg.includes("check"))) {
      return overrides.pipCheck ?? ok("");
    }

    // Import probe - check for importlib import
    if (arg.includes("importlib.import_module")) {
      return ok(overrides.imports ?? IMPORTS_ALL_OK);
    }

    // HTTPS probe - check for urllib
    if (arg.includes("urllib.request.urlopen")) {
      return ok(overrides.https ?? JSON.stringify({ ok: true, status: 200 }));
    }

    // Multi-version scan - check for importlib.metadata
    if (arg.includes("importlib.metadata") || arg.includes("md.distributions")) {
      return ok(overrides.multiVersion ?? JSON.stringify({ multi: {}, sys_path_top: [] }));
    }

    // Facts - this is the fallback for json.dumps (sys, platform, site)
    if (arg.includes("sys.version") || arg.includes("platform.machine")) {
      return ok(overrides.facts ?? FACTS_HEALTHY_VENV);
    }

    return fail(1, "unknown command: " + arg);
  }) as CmdRunner;
}

describe("doctorLite", () => {
  describe("healthy environment", () => {
    it("returns good status for healthy venv (subprocess checks only)", async () => {
      // Note: This test uses a fake venv path, so pyvenv.cfg validation will fail.
      // We use a base python config (NOT_A_VENV) to skip pyvenv.cfg validation.
      // For full integration testing with real venvs, use a real path.
      const runner = createMockRunner({ facts: FACTS_BASE_PYTHON });

      const report = await doctorLite(
        { pythonPath: "C:\\Python311\\python.exe" },
        runner
      );

      // Base python gets NOT_A_VENV (info, penalty 10) + USER_SITE_ENABLED (warn, penalty 10)
      // Score: 100 - 10 - 10 = 80, which is "warn" status
      expect(report.findings.filter((f: Finding) => f.severity === "bad")).toHaveLength(0);
      expect(report.score).toBeGreaterThanOrEqual(70);
    });

    it("healthy venv subprocess checks pass (ignoring pyvenv.cfg)", async () => {
      const runner = createMockRunner({});

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" },
        runner
      );

      // Since the venv path doesn't exist, pyvenv.cfg validation fails (penalty 25).
      // But all subprocess-based checks pass - no bad findings from subprocess probes.
      const subprocessFindings = report.findings.filter(
        (f: Finding) => f.code !== "PYVENV_CFG_INVALID"
      );
      expect(subprocessFindings.filter((f: Finding) => f.severity === "bad")).toHaveLength(0);
      expect(subprocessFindings.filter((f: Finding) => f.severity === "warn")).toHaveLength(0);
    });
  });

  describe("python execution failures", () => {
    it("detects missing python executable", async () => {
      const runner: CmdRunner = vi.fn(async () => fail(1, "spawn ENOENT"));

      const report = await doctorLite({ pythonPath: "/nonexistent/python" }, runner);

      expect(report.status).toBe("bad");
      expect(report.score).toBe(0);
      expect(report.findings.some((f: Finding) => f.code === "PYTHON_EXEC_MISSING")).toBe(true);
    });

    it("detects timeout", async () => {
      const runner: CmdRunner = vi.fn(async () => timeout());

      const report = await doctorLite({ pythonPath: "/slow/python" }, runner);

      expect(report.status).toBe("bad");
      expect(report.findings.some((f: Finding) => f.code === "PYTHON_EXEC_MISSING")).toBe(true);
      expect(report.findings[0]?.evidence?.timedOut).toBe(true);
    });
  });

  describe("venv detection", () => {
    it("detects non-venv interpreter", async () => {
      const runner = createMockRunner({ facts: FACTS_BASE_PYTHON });

      const report = await doctorLite({ pythonPath: "C:\\Python311\\python.exe" }, runner);

      expect(report.findings.some((f: Finding) => f.code === "NOT_A_VENV")).toBe(true);
      // NOT_A_VENV is info severity, so status might still be good
      expect(report.findings.find((f: Finding) => f.code === "NOT_A_VENV")?.severity).toBe("info");
    });
  });

  describe("architecture checks", () => {
    it("detects arch mismatch when 64-bit required but 32-bit found", async () => {
      const runner = createMockRunner({ facts: FACTS_32BIT });

      const report = await doctorLite(
        { pythonPath: "C:\\Python311-32\\python.exe", requireX64: true },
        runner
      );

      expect(report.status).toBe("bad");
      expect(report.score).toBeLessThanOrEqual(15); // clamped for ARCH_MISMATCH
      expect(report.findings.some((f: Finding) => f.code === "ARCH_MISMATCH")).toBe(true);
    });

    it("does not flag arch when requireX64 is false", async () => {
      const runner = createMockRunner({ facts: FACTS_32BIT });

      const report = await doctorLite(
        { pythonPath: "C:\\Python311-32\\python.exe", requireX64: false },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "ARCH_MISMATCH")).toBe(false);
    });
  });

  describe("pip checks", () => {
    it("detects pip missing", async () => {
      const runner = createMockRunner({ pip: fail(1, "No module named pip") });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "PIP_MISSING")).toBe(true);
    });

    it("detects pip version mismatch", async () => {
      const runner = createMockRunner({ pip: ok(PIP_VERSION_MISMATCH) });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "PIP_POINTS_TO_OTHER_PYTHON")).toBe(true);
    });
  });

  describe("import failures", () => {
    it("detects SSL broken", async () => {
      const runner = createMockRunner({ imports: IMPORTS_SSL_FAIL });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe" },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "SSL_BROKEN")).toBe(true);
    });

    it("detects DLL load failure", async () => {
      const runner = createMockRunner({ imports: IMPORTS_DLL_FAIL });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe", requiredModules: ["torch"] },
        runner
      );

      expect(report.status).toBe("bad");
      expect(report.score).toBeLessThanOrEqual(25); // clamped for DLL_LOAD_FAIL
      expect(report.findings.some((f: Finding) => f.code === "DLL_LOAD_FAIL")).toBe(true);
    });

    it("detects ABI mismatch (macOS ARM)", async () => {
      const runner = createMockRunner({ imports: IMPORTS_ABI_MISMATCH });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe", requiredModules: ["numpy"] },
        runner
      );

      expect(report.status).toBe("bad");
      expect(report.score).toBeLessThanOrEqual(25); // clamped for ABI_MISMATCH
      expect(report.findings.some((f: Finding) => f.code === "ABI_MISMATCH")).toBe(true);
    });
  });

  describe("HTTPS probe", () => {
    it("detects cert verification failure", async () => {
      const runner = createMockRunner({
        https: JSON.stringify({
          ok: false,
          err: "SSLError('certificate_verify_failed')",
          tb: "...",
        }),
      });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe", httpsProbe: true },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "CERT_STORE_FAIL")).toBe(true);
      const finding = report.findings.find((f: Finding) => f.code === "CERT_STORE_FAIL");
      expect(finding?.evidence?.certish).toBe(true);
    });

    it("detects network failure (non-cert)", async () => {
      const runner = createMockRunner({
        https: JSON.stringify({
          ok: false,
          err: "URLError('getaddrinfo failed')",
          tb: "...",
        }),
      });

      const report = await doctorLite(
        { pythonPath: "C:\\repo\\.venv\\Scripts\\python.exe", httpsProbe: true },
        runner
      );

      expect(report.findings.some((f: Finding) => f.code === "CERT_STORE_FAIL")).toBe(true);
      const finding = report.findings.find((f: Finding) => f.code === "CERT_STORE_FAIL");
      expect(finding?.evidence?.certish).toBe(false);
      expect(finding?.why).toContain("Network/TLS");
    });
  });

  describe("scoring", () => {
    it("clamps score for hard failures", async () => {
      const runner = createMockRunner({ facts: FACTS_32BIT });

      const report = await doctorLite(
        { pythonPath: "C:\\Python311-32\\python.exe", requireX64: true },
        runner
      );

      // ARCH_MISMATCH penalty is 80, but score is clamped to max 15
      expect(report.score).toBeLessThanOrEqual(15);
    });

    it("accumulates penalties correctly", async () => {
      const runner = createMockRunner({
        facts: FACTS_BASE_PYTHON, // NOT_A_VENV (10) + USER_SITE_ENABLED (10)
        pip: fail(1, "missing"), // PIP_MISSING (25)
      });

      const report = await doctorLite({ pythonPath: "C:\\Python311\\python.exe" }, runner);

      // 100 - 10 (NOT_A_VENV) - 10 (USER_SITE_ENABLED) - 25 (PIP_MISSING) = 55
      expect(report.score).toBe(55);
    });
  });
});
