# Agent Guidelines

## Commands
- **Install**: `bun install`
- **Type check**: `bun run tsc --noEmit`
- **Test**: `bun test`

## Code Style
- **Runtime**: Bun (use Bun APIs: `Bun.file()`, `Bun.write()`, `Bun.Glob`, `Bun.$`)
- **Imports**: Use `import type` for type-only imports (`verbatimModuleSyntax`)
- **Types**: Strict mode enabled, handle `undefined` from indexed access (`noUncheckedIndexedAccess`)
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Exports**: Re-export public API from `index.ts`, implementation in `src/`

## Plugin Structure
- Tools use `@opencode-ai/plugin` `tool()` helper with Zod-like schema (`tool.schema`)
- Plugin exports async function returning `{ tool: { ... } }`
- Logs stored in `.opencode/logs/sessions/` as JSONL files organized by session
