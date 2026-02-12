# venvkit v0.1.0 - Stop Fighting Your Python Environments

**FOR IMMEDIATE RELEASE**

---

## The Problem

If you've ever trained a PyTorch model on Windows, you've hit this:

```
ImportError: DLL load failed while importing _C: The specified module could not be found.
```

Or this classic:

```
ssl.SSLCertVerificationError: certificate verify failed
```

You have 12 Python environments across 6 projects. Something broke in one of them. Maybe all of them. You don't know which venv has the corrupted SSL, which one accidentally inherited your user site-packages, or why `pytest` works in project A but crashes in project B *with the same code*.

You spend 45 minutes recreating venvs that might have been fine.

**venvkit fixes this.**

---

## What It Does

**venvkit** is a diagnostic toolkit that:

1. **Scans** your system for every Python environment (venvs, conda, pyenv, base interpreters)
2. **Diagnoses** each one for common Windows ML failures:
   - SSL/TLS certificate issues
   - DLL load failures (PyTorch, CUDA, native extensions)
   - ABI mismatches (ARM wheels on x86, wrong Python version)
   - pip conflicts and corruption
   - User-site and PYTHONPATH leakage (the "works on my machine" bug)
3. **Tracks** which tasks ran on which environments (and whether they passed)
4. **Detects** flaky tasks — ones that pass sometimes, fail others
5. **Visualizes** your ecosystem as a graph showing base interpreters, venvs, tasks, and failure patterns

---

## Key Features

### doctorLite
One-command health check for any Python interpreter:

```typescript
const report = await doctorLite({
  pythonPath: 'C:\\project\\.venv\\Scripts\\python.exe',
  requiredModules: ['torch', 'transformers'],
  httpsProbe: true,
});

// report.status: 'good' | 'warn' | 'bad'
// report.score: 0-100
// report.findings: [{ code: 'SSL_BROKEN', severity: 'bad', ... }]
```

### Ecosystem Map
Renders your entire Python landscape:

```bash
node dist/map_cli.js --root C:\projects
```

Outputs:
- `venv-map.json` — Full graph data
- `venv-map.mmd` — Mermaid diagram
- `venv-map.html` — Interactive viewer
- `insights.json` — Actionable recommendations

### Task Clustering
Track runs over time and detect patterns:

```typescript
const clusters = clusterRuns(runs);
for (const c of clusters) {
  if (isFlaky(c)) {
    console.log(`${c.sig.name} is flaky: ${c.successRate * 100}% success`);
    console.log(`Fails most on: ${getFailingEnvs(c, 2).map(e => e.pythonPath)}`);
  }
}
```

### Blast Radius Analysis
When a base interpreter goes bad, venvkit tells you which downstream venvs are affected:

```
Insight: Base interpreter "C:\Python311" has a large blast radius:
5/6 attached envs are bad. Fix the base first, then recreate envs.
```

---

## Why This Matters

Most ML debugging time isn't spent on models — it's spent on environment issues.

- **DLL hell** is real on Windows
- **SSL breaks** constantly (OpenSSL updates, cert store changes)
- **Path leakage** causes "works here, fails there" bugs
- **Flaky tests** waste CI minutes and developer patience

venvkit gives you visibility into problems you couldn't see before. Instead of guessing which venv is broken, you know. Instead of recreating all 12 environments, you fix the one bad base interpreter.

---

## Getting Started

```bash
git clone https://github.com/mcp-tool-shop-org/venvkit
cd venvkit
npm install
npm run build

# Scan your system
node dist/map_cli.js --root C:\projects --httpsProbe
```

---

## Technical Details

- **TypeScript** — Full type safety, ESM modules
- **Zero runtime dependencies** — Just Node.js built-ins
- **81 tests** — Comprehensive coverage with injectable runners
- **Windows-first** — Designed for the platform where Python environments hurt most

---

## Links

- **Repository**: https://github.com/mcp-tool-shop-org/venvkit
- **Release**: v0.1.0

---

## What's Next

- Integration with task routers (auto-select best env for each task)
- Conda environment support improvements
- GitHub Actions integration for CI environment health
- Package dependency graph overlay

---

*venvkit: Because life's too short to debug venvs.*
