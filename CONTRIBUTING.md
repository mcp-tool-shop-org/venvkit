# Contributing to venvkit

Thanks for your interest in improving venvkit.

## Quick Start

```bash
git clone https://github.com/mcp-tool-shop/venvkit
cd venvkit
npm install
npm test
```

## Development Workflow

1. **Fork and clone** the repository
2. **Create a branch** for your change: `git checkout -b feature/my-change`
3. **Make changes** and add tests
4. **Run checks**:
   ```bash
   npm run typecheck  # TypeScript
   npm test           # Vitest
   npm run build      # Compile
   ```
5. **Commit** with a clear message
6. **Push** and open a PR

## What We're Looking For

### High-Value Contributions

- **New Finding codes** — If you've hit a Python environment failure we don't detect, add it
- **Platform support** — Linux/macOS path handling, conda detection improvements
- **Integration examples** — CI scripts, task router hooks, MCP server integration

### Code Quality

- Tests required for new features
- Type safety — no `any` escapes
- Keep dependencies at zero (Node.js built-ins only)

## Adding a New Finding Code

1. Add the code to `doctorLite.ts`:
   ```typescript
   // In the findings array
   findings.push({
     code: 'MY_NEW_ISSUE',
     severity: 'warn', // 'info' | 'warn' | 'bad'
     penalty: 15,
     what: 'Short description',
     why: 'Why this matters',
     fix: ['Step 1', 'Step 2'],
   });
   ```

2. Add a test in `doctorLite.test.ts`

3. Add emoji mapping in `mapRender.ts`:
   ```typescript
   case 'MY_NEW_ISSUE':
     return '🔧';
   ```

4. Add hint in `mapRender.ts`:
   ```typescript
   case 'MY_NEW_ISSUE':
     return 'How to fix this issue.';
   ```

5. Document in README.md Finding Codes table

## Commit Messages

Format: `type: description`

Types:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Test changes
- `refactor:` Code restructuring

## Questions?

Open an issue with the "question" label.
