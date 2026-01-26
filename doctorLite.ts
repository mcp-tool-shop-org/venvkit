// venvkit/doctorLite.ts
// Doctor-lite runner: fast, deterministic environment checks for a given Python interpreter.
// - Runs ~2–4 subprocesses (facts, pip, imports, optional https probe)
// - Produces findings (what/why/fix), score (0–100), status (good/warn/bad/unknown)
// - Designed to feed router + venv map

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type Severity = "info" | "warn" | "bad";
export type HealthStatus = "good" | "warn" | "bad" | "unknown";

export type FindingCode =
  | "PYTHON_EXEC_MISSING"
  | "NOT_A_VENV"
  | "ARCH_MISMATCH"
  | "PIP_MISSING"
  | "PIP_POINTS_TO_OTHER_PYTHON"
  | "PYTHONPATH_INJECTED"
  | "USER_SITE_ENABLED"
  | "USER_SITE_LEAK"
  | "PIP_CHECK_FAIL"
  | "MULTI_VERSION_ON_PATH"
  | "RESOLVER_CONFLICT_HINT"
  | "OUTDATED_INSTALL_TOOLING"
  | "IMPORT_FAIL"
  | "DLL_LOAD_FAIL"
  | "ABI_MISMATCH"
  | "SSL_BROKEN"
  | "CERT_STORE_FAIL"
  | "SUBPROCESS_BROKEN"
  | "PYVENV_CFG_INVALID";

export type Finding = {
  code: FindingCode;
  severity: Severity;
  penalty: number; // scoring penalty
  what: string;
  why: string;
  fix: Array<{ title: string; steps: string[] }>;
  evidence?: Record<string, unknown>;
};

export type RunResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CmdRunner = (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<RunResult>;

export type DoctorLiteOptions = {
  /** Python executable path (venv python or base python). Required. */
  pythonPath: string;

  /** Modules to import-test (task required caps). */
  requiredModules?: string[];

  /** If true, also do a HTTPS probe to pypi.org (can fail in corp MITM; still useful). */
  httpsProbe?: boolean;

  /** If task requires 64-bit python, set true. If unknown, leave undefined. */
  requireX64?: boolean;

  /** Timeout per subprocess (ms). */
  timeoutMs?: number;

  /** If true, run heavier checks (pip check, multi-version scan). */
  strict?: boolean;

  /** Override environment variables passed to python. */
  env?: Record<string, string | undefined>;
};

export type DoctorLiteReport = {
  pythonPath: string;
  ranAt: string;
  status: HealthStatus;
  score: number; // 0-100
  summary: string;
  facts?: FactsResult;
  findings: Finding[];
};

type FactsResult = {
  version: string;
  version_info: number[];
  executable: string;
  prefix: string;
  base_prefix: string | null;
  bits: number;
  machine: string;
  os: string;
  py_path: string[];
  enable_user_site: boolean | null;
  user_site: string;
};

function nowIso() {
  return new Date().toISOString();
}

function mergeEnv(base: NodeJS.ProcessEnv, overrides?: Record<string, string | undefined>) {
  return { ...base, ...(overrides ?? {}) };
}

/**
 * Run a subprocess with timeout, capturing stdout/stderr.
 */
export async function runCmd(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + String(err),
        timedOut,
      });
    });
  });
}

function jsonOrNull<T>(s: string): T | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function classifyImportFailure(text: string): "DLL_LOAD_FAIL" | "ABI_MISMATCH" | "IMPORT_FAIL" {
  const t = text.toLowerCase();

  // Windows
  if (t.includes("dll load failed")) return "DLL_LOAD_FAIL";
  if (t.includes("winerror 193") || t.includes("not a valid win32 application")) return "ABI_MISMATCH";
  if (t.includes("winerror 126") || t.includes("the specified module could not be found")) return "DLL_LOAD_FAIL";
  if (t.includes("winerror 127") || t.includes("procedure could not be found")) return "ABI_MISMATCH";

  // Linux
  if (t.includes("cannot open shared object file")) return "DLL_LOAD_FAIL";
  if (t.includes("glibc_") || t.includes("undefined symbol")) return "ABI_MISMATCH";

  // macOS - general
  if (t.includes("library not loaded")) return "DLL_LOAD_FAIL";
  if (t.includes("symbol not found")) return "ABI_MISMATCH";
  if (t.includes("incompatible architecture") || t.includes("mach-o")) return "ABI_MISMATCH";

  // macOS ARM-specific patterns
  if (t.includes("mach-o file, but is an incompatible architecture")) return "ABI_MISMATCH";
  if (t.includes("bad cpu type in executable")) return "ABI_MISMATCH";

  return "IMPORT_FAIL";
}

function clampScoreForHardFails(score: number, findings: Finding[]) {
  const codes = new Set(findings.map((f) => f.code));
  if (codes.has("PYTHON_EXEC_MISSING")) return 0;
  if (codes.has("ARCH_MISMATCH")) return Math.min(score, 15);
  if (codes.has("DLL_LOAD_FAIL") || codes.has("ABI_MISMATCH")) return Math.min(score, 25);
  if (codes.has("SUBPROCESS_BROKEN")) return Math.min(score, 25);
  return score;
}

function computeStatus(score: number, findings: Finding[]): HealthStatus {
  if (findings.some((f) => f.severity === "bad")) return "bad";
  if (score >= 85) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function scoreReport(findings: Finding[]): { score: number; status: HealthStatus } {
  const penalty = findings.reduce((sum, f) => sum + (f.penalty ?? 0), 0);
  let score = Math.max(0, 100 - penalty);
  score = clampScoreForHardFails(score, findings);
  const status = computeStatus(score, findings);
  return { score, status };
}

function baseFixRecreateVenv(pythonPath: string) {
  return [
    `If this is a venv, consider recreating it:`,
    `  1) delete the venv directory`,
    `  2) recreate: "${pythonPath}" -m venv .venv`,
    `  3) upgrade tooling: ".venv/bin/python" -m pip install -U pip setuptools wheel`,
  ];
}

function mkFinding(partial: Omit<Finding, "fix"> & { fix?: Finding["fix"] }): Finding {
  return {
    ...partial,
    fix:
      partial.fix ??
      [
        {
          title: "Safe",
          steps: baseFixRecreateVenv("<python>"),
        },
      ],
  };
}

/**
 * Validate pyvenv.cfg for a venv interpreter.
 * Checks that the file exists and contains a valid 'home' line.
 */
async function validatePyvenvCfg(
  pythonPath: string
): Promise<{ ok: boolean; cfgPath?: string; reason?: string; home?: string }> {
  // pythonPath: <venv>/Scripts/python.exe OR <venv>/bin/python
  const dir = path.dirname(pythonPath);
  // Scripts/.. or bin/..
  const venvRoot = path.resolve(dir, "..");
  const cfgPath = path.join(venvRoot, "pyvenv.cfg");

  try {
    const txt = await fs.readFile(cfgPath, "utf8");
    const homeLine = txt.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("home"));
    if (!homeLine) return { ok: false, cfgPath, reason: "Missing 'home =' line" };

    const home = homeLine.split("=").slice(1).join("=").trim();
    if (!home) return { ok: false, cfgPath, reason: "Empty 'home' value" };

    // Best-effort existence check (don't hard fail portable layouts)
    try {
      await fs.stat(home);
    } catch {
      return { ok: false, cfgPath, reason: `home path does not exist: ${home}`, home };
    }

    return { ok: true, cfgPath, home };
  } catch (e) {
    return { ok: false, cfgPath, reason: `Cannot read pyvenv.cfg: ${String(e)}` };
  }
}

export async function doctorLite(
  opts: DoctorLiteOptions,
  runner: CmdRunner = runCmd
): Promise<DoctorLiteReport> {
  const timeoutMs = opts.timeoutMs ?? 6000;

  // Controlled env for python probes (avoid false positives)
  const controlledEnv = mergeEnv(process.env, {
    ...opts.env,
    // prevent user site leakage during probes (we detect it explicitly from facts)
    PYTHONNOUSERSITE: "1",
    // keep empty to avoid hidden path injections
    PYTHONPATH: "",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  });

  const findings: Finding[] = [];

  // 0) Quick existence/subprocess check
  const hello = await runner(opts.pythonPath, ["-c", "print('ok')"], { env: controlledEnv, timeoutMs });
  if (!hello.ok) {
    findings.push(
      mkFinding({
        code: "PYTHON_EXEC_MISSING",
        severity: "bad",
        penalty: 100,
        what: "Python interpreter cannot be executed",
        why: hello.timedOut ? "Subprocess timed out or was killed" : "Spawn failed or exited non-zero",
        fix: [
          {
            title: "Quick",
            steps: [
              `Verify the path exists and is executable: ${opts.pythonPath}`,
              `If this is a venv, ensure it wasn't deleted or moved.`,
              `If managed by an IDE/tool, reselect the interpreter.`,
            ],
          },
          { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
        ],
        evidence: { stderr: hello.stderr, exitCode: hello.exitCode, timedOut: hello.timedOut },
      })
    );

    const { score, status } = scoreReport(findings);
    return {
      pythonPath: opts.pythonPath,
      ranAt: nowIso(),
      status,
      score,
      summary: "Python could not be executed.",
      findings,
    };
  }

  // 1) Facts (always)
  const factsScript =
    "import json, sys, platform, site, struct;" +
    "print(json.dumps({" +
    "'version': sys.version," +
    "'version_info': list(sys.version_info)," +
    "'executable': sys.executable," +
    "'prefix': sys.prefix," +
    "'base_prefix': getattr(sys,'base_prefix',None)," +
    "'bits': struct.calcsize('P')*8," +
    "'machine': platform.machine()," +
    "'os': platform.system().lower()," +
    "'py_path': sys.path[:15]," +
    "'enable_user_site': getattr(site,'ENABLE_USER_SITE',None)," +
    "'user_site': site.getusersitepackages()" +
    "}))";

  const factsRes = await runner(opts.pythonPath, ["-c", factsScript], { env: controlledEnv, timeoutMs });
  const facts = factsRes.ok ? jsonOrNull<FactsResult>(factsRes.stdout.trim()) : null;

  if (!facts) {
    findings.push(
      mkFinding({
        code: "SUBPROCESS_BROKEN",
        severity: "bad",
        penalty: 40,
        what: "Python subprocess returned unexpected output",
        why: "Could not parse JSON facts; environment may be unstable or output was intercepted",
        fix: [
          {
            title: "Quick",
            steps: [
              `Try running directly:`,
              `  "${opts.pythonPath}" -c "import sys; print(sys.version)"`,
              `If this prints, but JSON fails, check for sitecustomize/usercustomize that prints to stdout.`,
            ],
          },
          { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
        ],
        evidence: { stdout: factsRes.stdout, stderr: factsRes.stderr },
      })
    );
  } else {
    // a) venv wiring - explicit null handling
    const basePrefix = facts.base_prefix ?? "";
    const isVenv = basePrefix.length > 0 && facts.prefix !== basePrefix;

    if (!isVenv) {
      findings.push(
        mkFinding({
          code: "NOT_A_VENV",
          severity: "info",
          penalty: 10,
          what: "Interpreter is not a virtual environment",
          why: "sys.prefix equals sys.base_prefix",
          fix: [
            {
              title: "Quick",
              steps: [
                `If you expected a venv, you are likely using the base interpreter.`,
                `Create and select a venv:`,
                `  "${opts.pythonPath}" -m venv .venv`,
                `  ".venv\\Scripts\\python" -m pip install -U pip setuptools wheel`,
              ],
            },
          ],
          evidence: { prefix: facts.prefix, base_prefix: facts.base_prefix },
        })
      );
    } else {
      // Validate pyvenv.cfg for venvs
      const cfg = await validatePyvenvCfg(opts.pythonPath);
      if (!cfg.ok) {
        findings.push(
          mkFinding({
            code: "PYVENV_CFG_INVALID",
            severity: "warn",
            penalty: 25,
            what: "pyvenv.cfg appears invalid or stale",
            why: cfg.reason ?? "pyvenv.cfg validation failed",
            fix: [
              {
                title: "Quick",
                steps: [
                  "Recreate the venv (recommended).",
                  `Delete venv folder and run: "${opts.pythonPath}" -m venv .venv`,
                ],
              },
            ],
            evidence: { cfgPath: cfg.cfgPath, home: cfg.home, reason: cfg.reason },
          })
        );
      }
    }

    // b) PYTHONPATH injected (based on parent env)
    const rawPyPath = process.env.PYTHONPATH;
    if (rawPyPath && rawPyPath.trim() !== "") {
      findings.push(
        mkFinding({
          code: "PYTHONPATH_INJECTED",
          severity: "warn",
          penalty: 15,
          what: "PYTHONPATH is set in the host environment",
          why: "It can shadow venv packages and cause non-reproducible imports",
          fix: [
            {
              title: "Safe",
              steps: [
                `Remove PYTHONPATH from your shell/profile/IDE settings.`,
                `If you need local code, use editable installs: pip install -e .`,
              ],
            },
          ],
          evidence: { PYTHONPATH: rawPyPath },
        })
      );
    }

    // c) arch mismatch
    if (opts.requireX64 === true && facts.bits !== 64) {
      findings.push(
        mkFinding({
          code: "ARCH_MISMATCH",
          severity: "bad",
          penalty: 80,
          what: "Python architecture mismatch",
          why: `Task requires 64-bit, but interpreter is ${facts.bits}-bit`,
          fix: [
            {
              title: "Quick",
              steps: [
                `Install/select a 64-bit Python interpreter.`,
                `Recreate the venv with the correct interpreter.`,
              ],
            },
          ],
          evidence: { bits: facts.bits, machine: facts.machine },
        })
      );
    }

    // d) user site enabled/leaking
    if (facts.enable_user_site === true) {
      findings.push(
        mkFinding({
          code: "USER_SITE_ENABLED",
          severity: "warn",
          penalty: 10,
          what: "User site-packages are enabled",
          why: "This can allow --user installs to leak into your environment",
          fix: [
            {
              title: "Quick",
              steps: [
                `Prefer running with PYTHONNOUSERSITE=1 for tooling.`,
                `Avoid pip install --user for development environments.`,
              ],
            },
          ],
          evidence: { enable_user_site: facts.enable_user_site, user_site: facts.user_site },
        })
      );
    }

    const inSysPath = Array.isArray(facts.py_path) && facts.user_site && facts.py_path.includes(facts.user_site);
    if (inSysPath) {
      findings.push(
        mkFinding({
          code: "USER_SITE_LEAK",
          severity: "warn",
          penalty: 20,
          what: "User site-packages appear on sys.path",
          why: "Packages installed with --user may shadow venv packages",
          fix: [
            {
              title: "Safe",
              steps: [
                `Remove user-site leakage:`,
                `  - unset PYTHONPATH / remove .pth hacks`,
                `  - run with PYTHONNOUSERSITE=1`,
                `  - recreate the venv`,
              ],
            },
          ],
          evidence: { user_site: facts.user_site, sys_path_top: facts.py_path },
        })
      );
    }
  }

  // 2) pip sanity (always try)
  const pipVer = await runner(opts.pythonPath, ["-m", "pip", "--version"], { env: controlledEnv, timeoutMs });
  if (!pipVer.ok) {
    findings.push(
      mkFinding({
        code: "PIP_MISSING",
        severity: "warn",
        penalty: 25,
        what: "pip is missing or not runnable",
        why: "python -m pip failed",
        fix: [
          {
            title: "Quick",
            steps: [
              `Try: "${opts.pythonPath}" -m ensurepip --upgrade`,
              `Then: "${opts.pythonPath}" -m pip install -U pip setuptools wheel`,
            ],
          },
          { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
        ],
        evidence: { stderr: pipVer.stderr, exitCode: pipVer.exitCode },
      })
    );
  } else {
    // detect mismatch in "pip X from ... (python 3.Y)"
    const m = pipVer.stdout.match(/\(python\s+(\d+\.\d+)\)/i);
    const pyVersion = facts?.version_info?.length ? `${facts.version_info[0]}.${facts.version_info[1]}` : null;
    if (m && pyVersion && m[1] !== pyVersion) {
      findings.push(
        mkFinding({
          code: "PIP_POINTS_TO_OTHER_PYTHON",
          severity: "warn",
          penalty: 30,
          what: "pip appears associated with a different Python version",
          why: `pip reports python ${m[1]} but interpreter is ${pyVersion}`,
          fix: [
            {
              title: "Safe",
              steps: [
                `Upgrade pip via the interpreter to rebind it:`,
                `  "${opts.pythonPath}" -m pip install -U pip setuptools wheel`,
                `If it persists, recreate the venv.`,
              ],
            },
          ],
          evidence: { pipVersion: pipVer.stdout.trim(), interpreter: opts.pythonPath },
        })
      );
    }
  }

  if (opts.strict) {
    const pipCheck = await runner(opts.pythonPath, ["-m", "pip", "check"], { env: controlledEnv, timeoutMs });
    if (!pipCheck.ok) {
      findings.push(
        mkFinding({
          code: "PIP_CHECK_FAIL",
          severity: "warn",
          penalty: 25,
          what: "Installed packages have broken requirements",
          why: "pip check reported conflicts or missing requirements",
          fix: [
            {
              title: "Quick",
              steps: [
                `Run: "${opts.pythonPath}" -m pip check`,
                `Then reinstall the reported packages (or recreate the venv).`,
              ],
            },
            { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
          ],
          evidence: { stdout: pipCheck.stdout, stderr: pipCheck.stderr, exitCode: pipCheck.exitCode },
        })
      );
    }
  }

  // 3) Import tests (always include ssl; add required modules)
  const modules = Array.from(
    new Set(["ssl", "ctypes", "sqlite3", ...(opts.requiredModules ?? [])].filter(Boolean))
  );

  const importScript =
    "import json, importlib, traceback;" +
    `mods=${JSON.stringify(modules)};` +
    "out=[];" +
    "for m in mods:" +
    "  try:" +
    "    importlib.import_module(m);" +
    "    out.append({'module':m,'ok':True});" +
    "  except Exception as e:" +
    "    out.append({'module':m,'ok':False,'err':repr(e),'tb':traceback.format_exc()});" +
    "print(json.dumps({'imports':out}))";

  const importsRes = await runner(opts.pythonPath, ["-c", importScript], { env: controlledEnv, timeoutMs });
  const importsJson = importsRes.ok
    ? jsonOrNull<{ imports: Array<{ module: string; ok: boolean; err?: string; tb?: string }> }>(
        importsRes.stdout.trim()
      )
    : null;

  if (!importsJson) {
    findings.push(
      mkFinding({
        code: "SUBPROCESS_BROKEN",
        severity: "bad",
        penalty: 40,
        what: "Import probe failed",
        why: "Could not parse import probe output; environment may be unstable",
        fix: [{ title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) }],
        evidence: { stdout: importsRes.stdout, stderr: importsRes.stderr },
      })
    );
  } else {
    for (const r of importsJson.imports) {
      if (r.ok) continue;

      const text = `${r.err ?? ""}\n${r.tb ?? ""}`.trim();

      // Special case: ssl fail => SSL_BROKEN
      if (r.module === "ssl") {
        findings.push(
          mkFinding({
            code: "SSL_BROKEN",
            severity: "bad",
            penalty: 40,
            what: "SSL module cannot be imported",
            why: "OpenSSL libraries are missing, incompatible, or blocked",
            fix: [
              {
                title: "Quick",
                steps: [
                  `If on Windows: reinstall Python from python.org (matching x64/x86)`,
                  `Recreate the venv after reinstalling.`,
                ],
              },
              { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
            ],
            evidence: { module: r.module, err: r.err, tb: r.tb },
          })
        );
        continue;
      }

      const cls = classifyImportFailure(text);

      if (cls === "DLL_LOAD_FAIL") {
        findings.push(
          mkFinding({
            code: "DLL_LOAD_FAIL",
            severity: "bad",
            penalty: 55,
            what: `Native extension failed to load while importing ${r.module}`,
            why: "A required shared library/DLL is missing or not found in the loader path",
            fix: [
              {
                title: "Quick",
                steps: [
                  `Reinstall the failing package (and its deps):`,
                  `  "${opts.pythonPath}" -m pip install --force-reinstall --no-cache-dir ${r.module}`,
                  `If that doesn't work, recreate the venv.`,
                ],
              },
              {
                title: "Safe",
                steps: [
                  ...baseFixRecreateVenv(opts.pythonPath),
                  `If it's numpy/torch/scipy/etc., ensure you're using wheels for your platform (x64 vs arm64).`,
                ],
              },
            ],
            evidence: { module: r.module, err: r.err, tb: r.tb },
          })
        );
      } else if (cls === "ABI_MISMATCH") {
        findings.push(
          mkFinding({
            code: "ABI_MISMATCH",
            severity: "bad",
            penalty: 55,
            what: `Binary/ABI mismatch while importing ${r.module}`,
            why: "Compiled wheels are incompatible with your Python version or architecture",
            fix: [
              {
                title: "Quick",
                steps: [
                  `Verify python arch/version matches the package wheels.`,
                  `Recreate the venv using a compatible Python version (common: torch pins).`,
                ],
              },
              { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
            ],
            evidence: { module: r.module, err: r.err, tb: r.tb },
          })
        );
      } else {
        // IMPORT_FAIL: severity depends on whether it was required
        const isRequired =
          (opts.requiredModules ?? []).includes(r.module) || ["ctypes", "sqlite3"].includes(r.module);
        findings.push(
          mkFinding({
            code: "IMPORT_FAIL",
            severity: isRequired ? "bad" : "warn",
            penalty: isRequired ? 35 : 20,
            what: `Import failed: ${r.module}`,
            why: "Package missing, incompatible, or shadowed on sys.path",
            fix: [
              {
                title: "Quick",
                steps: [
                  `Install/repair the module:`,
                  `  "${opts.pythonPath}" -m pip install -U ${r.module}`,
                  `If installed, check for shadowing (PYTHONPATH / user-site leakage).`,
                ],
              },
              { title: "Safe", steps: baseFixRecreateVenv(opts.pythonPath) },
            ],
            evidence: { module: r.module, err: r.err, tb: r.tb },
          })
        );
      }
    }
  }

  // 4) Optional HTTPS probe (only if requested and ssl isn't broken)
  if (opts.httpsProbe && !findings.some((f) => f.code === "SSL_BROKEN")) {
    const httpsScript =
      "import json, urllib.request, traceback;" +
      "u='https://pypi.org/simple/';" +
      "try:" +
      "  with urllib.request.urlopen(u, timeout=5) as r:" +
      "    print(json.dumps({'ok':True,'status': getattr(r,'status',200)}))" +
      "except Exception as e:" +
      "  print(json.dumps({'ok':False,'err':repr(e),'tb':traceback.format_exc()}))";

    const httpsRes = await runner(opts.pythonPath, ["-c", httpsScript], { env: controlledEnv, timeoutMs });
    const httpsJson = httpsRes.ok
      ? jsonOrNull<{ ok: boolean; status?: number; err?: string; tb?: string }>(httpsRes.stdout.trim())
      : null;

    if (!httpsJson || httpsJson.ok !== true) {
      const errText = `${httpsJson?.err ?? ""}\n${httpsJson?.tb ?? ""}\n${httpsRes.stderr ?? ""}`.toLowerCase();

      const certish =
        errText.includes("certificate_verify_failed") ||
        errText.includes("unable to get local issuer certificate") ||
        errText.includes("self signed certificate");

      findings.push(
        mkFinding({
          code: "CERT_STORE_FAIL",
          severity: "warn",
          penalty: 25,
          what: "HTTPS probe failed",
          why: certish
            ? "Certificate verification failed (often corporate MITM or missing CA roots)"
            : "Network/TLS connection failed",
          fix: [
            {
              title: "Quick",
              steps: [
                certish
                  ? `If you're on a corporate network, install your org's root CA into the OS trust store (or configure a cert bundle).`
                  : `Check connectivity/DNS/proxy settings.`,
                `If this blocks installs, use an internal index or wheelhouse.`,
              ],
            },
          ],
          evidence: {
            certish,
            stdout: httpsRes.stdout,
            stderr: httpsRes.stderr,
            err: httpsJson?.err,
            tb: httpsJson?.tb,
          },
        })
      );
    }
  }

  // 5) Strict multi-version scan (optional, heavier)
  if (opts.strict) {
    const multiScript =
      "import json, sys;" +
      "try:" +
      "  import importlib.metadata as md" +
      "except Exception:" +
      "  import importlib_metadata as md" +
      "dists={};" +
      "for dist in md.distributions():" +
      "  name=(dist.metadata.get('Name','') or '').lower();" +
      "  if not name: continue;" +
      "  loc=str(dist.locate_file(''));" +
      "  ver=getattr(dist,'version','?');" +
      "  dists.setdefault(name, []).append({'version':ver,'location':loc});" +
      "multi={k:v for k,v in dists.items() if len({x['location'] for x in v})>1};" +
      "print(json.dumps({'multi':multi, 'sys_path_top': sys.path[:15]}))";

    const multiRes = await runner(opts.pythonPath, ["-c", multiScript], { env: controlledEnv, timeoutMs });
    const multiJson = multiRes.ok
      ? jsonOrNull<{
          multi: Record<string, Array<{ version: string; location: string }>>;
          sys_path_top: string[];
        }>(multiRes.stdout.trim())
      : null;

    if (multiJson && multiJson.multi && Object.keys(multiJson.multi).length > 0) {
      findings.push(
        mkFinding({
          code: "MULTI_VERSION_ON_PATH",
          severity: "warn",
          penalty: 20,
          what: "Multiple installations of the same package detected",
          why: "Duplicate distributions can shadow each other and cause unpredictable behavior",
          fix: [
            {
              title: "Safe",
              steps: [
                `Best fix is to recreate the venv.`,
                `If you must repair in place, uninstall until one remains, then reinstall:`,
                `  "${opts.pythonPath}" -m pip uninstall <pkg> (repeat)`,
                `  "${opts.pythonPath}" -m pip install <pkg>`,
              ],
            },
          ],
          evidence: { multi: multiJson.multi, sys_path_top: multiJson.sys_path_top },
        })
      );
    }
  }

  const { score, status } = scoreReport(findings);

  const top = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => (b.penalty ?? 0) - (a.penalty ?? 0))[0];

  const summary =
    top?.what ??
    (status === "good"
      ? "Environment looks healthy."
      : status === "warn"
        ? "Environment has warnings."
        : "Environment is unhealthy.");

  return {
    pythonPath: opts.pythonPath,
    ranAt: nowIso(),
    status,
    score,
    summary,
    facts: facts ?? undefined,
    findings,
  };
}

// Convenience: make a stable "env id" for mapping/logging
export function envIdFromPythonPath(pythonPath: string) {
  // Keep it simple and deterministic. You can upgrade to a hash later.
  const norm = os.platform() === "win32" ? pythonPath.toLowerCase() : pythonPath;
  return `py:${norm}`;
}
