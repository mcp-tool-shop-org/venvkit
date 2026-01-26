// scanEnvPaths.ts
//
// Discover Python environments on disk (venv + base interpreters) in a fast, pragmatic way.
// Outputs python executable paths you can feed into doctorLite + mapRender.
//
// Strategy (safe + useful defaults):
// - Project-local: .venv, venv, env, .python, .pyenv (common patterns)
// - Workspace roots you pass in
// - Global cache: ~/.venvkit/envs (if you use it)
// - Also looks for any directory containing pyvenv.cfg and a python executable.
//
// Notes:
// - This is discovery only. You still call doctorLite for health + facts.
// - On Windows we look for Scripts/python.exe; on POSIX bin/python.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type ScanOptions = {
  roots: string[]; // directories to scan (workspace roots)
  maxDepth?: number; // default 5
  includeHidden?: boolean; // default false
  includeUserHomeCache?: boolean; // default true
  dedupe?: boolean; // default true
};

export type ScanResult = {
  pythonPaths: string[]; // candidate python executables (venvs and base interpreters if found)
  meta: {
    scannedRoots: string[];
    maxDepth: number;
    foundVenvs: number;
    foundBases: number;
  };
};

function isWin() {
  return os.platform() === "win32";
}

function norm(p: string) {
  return isWin() ? p.toLowerCase() : p;
}

async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function venvPythonCandidates(venvRoot: string): string[] {
  return isWin()
    ? [path.join(venvRoot, "Scripts", "python.exe"), path.join(venvRoot, "Scripts", "python")]
    : [path.join(venvRoot, "bin", "python"), path.join(venvRoot, "bin", "python3")];
}

async function detectVenvAt(dir: string): Promise<string | null> {
  const cfg = path.join(dir, "pyvenv.cfg");
  if (!(await exists(cfg))) return null;

  for (const py of venvPythonCandidates(dir)) {
    if (await exists(py)) return py;
  }
  return null;
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function walkForVenvs(root: string, maxDepth: number, includeHidden: boolean, out: string[]) {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.depth > maxDepth) continue;

    // quick venv detection at this directory
    const venvPy = await detectVenvAt(cur.dir);
    if (venvPy) {
      out.push(venvPy);
      // Do not descend into this venv further (keeps scan fast)
      continue;
    }

    const children = await listDirSafe(cur.dir);
    for (const name of children) {
      if (!includeHidden && name.startsWith(".")) continue;

      const full = path.join(cur.dir, name);
      if (!(await isDir(full))) continue;

      // Skip common heavy directories
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".git") continue;

      stack.push({ dir: full, depth: cur.depth + 1 });
    }
  }
}

async function discoverProjectLocalRoots(root: string): Promise<string[]> {
  const candidates = [".venv", "venv", "env", ".python", ".pyenv"];
  const out: string[] = [];
  for (const c of candidates) {
    const p = path.join(root, c);
    if (await isDir(p)) out.push(p);
  }
  return out;
}

async function discoverBasePythons(): Promise<string[]> {
  // Best-effort:
  // - On Windows: common install locations
  // - On POSIX: common binaries
  const out: string[] = [];

  if (isWin()) {
    const possible = [
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      "C:\\Program Files\\Python312\\python.exe",
      "C:\\Program Files\\Python311\\python.exe",
      "C:\\Program Files\\Python310\\python.exe",
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python310", "python.exe"),
    ];
    for (const p of possible) if (await exists(p)) out.push(p);
  } else {
    const possible = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python"];
    for (const p of possible) if (await exists(p)) out.push(p);
  }

  return out;
}

export async function scanEnvPaths(options: ScanOptions): Promise<ScanResult> {
  const maxDepth = options.maxDepth ?? 5;
  const includeHidden = options.includeHidden ?? false;
  const includeUserHomeCache = options.includeUserHomeCache ?? true;
  const dedupe = options.dedupe ?? true;

  const roots = [...options.roots];

  if (includeUserHomeCache) {
    roots.push(path.join(os.homedir(), ".venvkit", "envs"));
    roots.push(path.join(os.homedir(), ".virtualenvs"));
  }

  const pythonPaths: string[] = [];

  // Fast pass: project-local patterns in each root
  for (const r of options.roots) {
    const locals = await discoverProjectLocalRoots(r);
    for (const venvRoot of locals) {
      const py = await detectVenvAt(venvRoot);
      if (py) pythonPaths.push(py);
    }
  }

  // Walk: find pyvenv.cfg
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    await walkForVenvs(root, maxDepth, includeHidden, pythonPaths);
  }

  // Optional: base interpreter candidates
  const bases = await discoverBasePythons();
  for (const b of bases) pythonPaths.push(b);

  const final = dedupe ? [...new Map(pythonPaths.map((p) => [norm(p), p])).values()] : pythonPaths;

  // crude counts
  const foundBases = bases.length;
  const foundVenvs = Math.max(0, final.length - foundBases);

  return {
    pythonPaths: final,
    meta: {
      scannedRoots: roots,
      maxDepth,
      foundVenvs,
      foundBases,
    },
  };
}
