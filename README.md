# venvkit

[![CI](https://github.com/mcp-tool-shop/venvkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mcp-tool-shop/venvkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Python virtual environment diagnostic toolkit for Windows ML workflows.**

Scans your system for Python environments, diagnoses health issues (SSL, DLLs, ABI mismatches, path leakage), tracks task execution history, detects flaky tasks, and renders an ecosystem map.

## 30-Second Quickstart

```bash
git clone https://github.com/mcp-tool-shop/venvkit && cd venvkit
npm install && npm run build
node dist/map_cli.js --root C:\projects --httpsProbe
# Open .venvkit/venv-map.html in your browser
```

## Features

- **doctorLite** - Fast health check for any Python interpreter
  - SSL/TLS verification
  - DLL load failures (common with PyTorch/CUDA)
  - ABI mismatches (ARM vs x86)
  - pip sanity checks
  - User-site and PYTHONPATH leakage detection

- **scanEnvPaths** - Discover all Python environments on your system
  - Finds venvs, conda envs, pyenv versions, base interpreters
  - Configurable depth and filtering

- **mapRender** - Visualize your Python ecosystem
  - Graph JSON output for programmatic use
  - Mermaid diagrams for documentation
  - Base interpreter grouping with blast radius analysis
  - Task routing visualization

- **runLog** - Track task execution history
  - Append-only JSONL format
  - Records which env ran what task
  - Captures success/failure with error classification

- **taskCluster** - Aggregate task runs by signature
  - Flaky task detection (inconsistent pass/fail)
  - Environment-dependent flake detection
  - Failure hotspot identification
  - Contagion analysis (shared root causes)

## Installation

```bash
npm install
npm run build
```

## CLI Usage

```bash
# Scan current directory and generate ecosystem map
node dist/map_cli.js

# Scan specific directories
node dist/map_cli.js --root C:\projects --root D:\ml-experiments

# Include task run history
node dist/map_cli.js --runlog .venvkit/runs.jsonl

# Output options
node dist/map_cli.js --out ./output --minScore 50 --strict --httpsProbe
```

### CLI Options

| Flag | Description |
|------|-------------|
| `--root, -r` | Directory to scan (can specify multiple) |
| `--out` | Output directory (default: `.venvkit`) |
| `--maxDepth` | Max directory depth to scan (default: 5) |
| `--strict` | Enable strict mode checks |
| `--httpsProbe` | Test HTTPS connectivity |
| `--minScore` | Filter envs below this health score |
| `--concurrency` | Parallel checks (default: CPU count) |
| `--runlog` | Path to task run log (JSONL) |
| `--no-tasks` | Skip task visualization |

### Outputs

| File | Description |
|------|-------------|
| `venv-map.json` | Full graph data (nodes, edges, summary) |
| `venv-map.mmd` | Mermaid diagram source |
| `venv-map.html` | Interactive viewer |
| `reports.json` | Raw doctorLite reports |
| `insights.json` | Actionable recommendations |

## Programmatic Usage

```typescript
import { doctorLite, scanEnvPaths, mapRender, readRunLog } from 'venvkit';

// Check a specific Python
const report = await doctorLite({
  pythonPath: 'C:\\project\\.venv\\Scripts\\python.exe',
  requiredModules: ['torch', 'transformers'],
  httpsProbe: true,
});

console.log(report.status); // 'good' | 'warn' | 'bad'
console.log(report.score);  // 0-100
console.log(report.findings); // Array of issues

// Scan for all Python environments
const scan = await scanEnvPaths({
  roots: ['C:\\projects'],
  maxDepth: 5,
});

// Run doctorLite on all found environments
const reports = await Promise.all(
  scan.pythonPaths.map(p => doctorLite({ pythonPath: p }))
);

// Load task execution history
const runs = await readRunLog('.venvkit/runs.jsonl');

// Generate ecosystem visualization
const { graph, mermaid, insights } = mapRender(reports, runs, {
  taskMode: 'clustered', // 'none' | 'runs' | 'clustered'
  includeHotEdgeLabels: true,
});
```

## Run Log Schema

Track task executions by appending events to a JSONL file:

```typescript
import { appendRunLog, newRunId } from 'venvkit';

await appendRunLog('.venvkit/runs.jsonl', {
  version: '1.0',
  runId: newRunId(),
  at: new Date().toISOString(),
  task: {
    name: 'train',
    command: 'python train.py --epochs 10',
    requirements: { packages: ['torch', 'transformers'] },
  },
  selected: {
    pythonPath: 'C:\\project\\.venv\\Scripts\\python.exe',
    score: 95,
    status: 'good',
  },
  outcome: {
    ok: true,
    exitCode: 0,
    durationMs: 45000,
  },
});
```

## Task Clustering

When you have many task runs, venvkit clusters them by signature:

```typescript
import { clusterRuns, isFlaky, getFailingEnvs } from 'venvkit';

const clusters = clusterRuns(runs);

for (const c of clusters) {
  console.log(`${c.sig.name}: ${c.ok}/${c.runs} (${(c.successRate * 100).toFixed(0)}%)`);

  if (isFlaky(c)) {
    console.log(`  WARNING: Flaky task!`);
    const badEnvs = getFailingEnvs(c, 3);
    console.log(`  Failing most on: ${badEnvs.map(e => e.pythonPath).join(', ')}`);
  }
}
```

## Graph Schema

The `mapRender` output follows a stable JSON schema:

```typescript
type GraphJSONv1 = {
  version: '1.0';
  generatedAt: string;
  host: { os: string; arch: string; hostname: string };
  summary: {
    envCount: number;
    baseCount: number;
    taskCount: number;
    healthy: number;
    warning: number;
    broken: number;
    runsPassed: number;
    runsFailed: number;
    topIssues: Array<{ code: string; count: number; hint: string }>;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
};
```

### Node Types

| Type | Description |
|------|-------------|
| `base` | Base Python interpreter (e.g., `C:\Python311`) |
| `venv` | Virtual environment |
| `task` | Task signature (clustered runs) |

### Edge Types

| Type | Description |
|------|-------------|
| `USES_BASE` | venv → base relationship |
| `ROUTES_TASK_TO` | task → env routing |
| `FAILED_RUN` | task → env failure (dashed in Mermaid) |

## Finding Codes

| Code | Severity | Description |
|------|----------|-------------|
| `SSL_BROKEN` | bad | SSL module fails to import |
| `CERT_STORE_FAIL` | warn | HTTPS certificate verification fails |
| `DLL_LOAD_FAIL` | bad | Native extension DLL loading fails |
| `ABI_MISMATCH` | bad | Binary incompatibility (ARM/x86) |
| `PIP_MISSING` | warn | pip not available |
| `PIP_CHECK_FAIL` | warn | Dependency conflicts detected |
| `USER_SITE_LEAK` | warn | User site-packages enabled in venv |
| `PYTHONPATH_INJECTED` | warn | PYTHONPATH environment variable set |
| `ARCH_MISMATCH` | bad | 32-bit Python when 64-bit required |
| `PYVENV_CFG_INVALID` | warn | Broken or missing pyvenv.cfg |

## Development

```bash
npm install
npm run typecheck  # Type check
npm run test       # Run tests
npm run build      # Build to dist/
```

## License

MIT
