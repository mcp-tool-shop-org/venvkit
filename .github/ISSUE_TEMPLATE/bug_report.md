---
name: Environment Bug Report
about: Report a Python environment issue venvkit should detect (but doesn't)
title: '[BUG] '
labels: bug
assignees: ''
---

## Environment

- **OS**: Windows 11 / Windows 10 / Linux / macOS
- **Node.js version**:
- **venvkit version**:

## Python Environment

```
Path: C:\path\to\python.exe
Version: 3.x.x
Type: venv / conda / pyenv / base
```

## What Happened

<!-- Describe the environment issue you encountered -->

## Expected Behavior

<!-- What should venvkit have detected? -->

## doctorLite Output

<!-- Run: node dist/map_cli.js --root <path> and paste the relevant report -->

```json
{
  "pythonPath": "...",
  "status": "...",
  "score": ...,
  "findings": [...]
}
```

## Additional Context

<!-- Any other information that might help -->
