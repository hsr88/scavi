# Scavi

The context linter for AI coding agents.

Scavi checks whether repository instructions such as `AGENTS.md`, `CLAUDE.md`, Copilot instructions, and Cursor rules still match the codebase.

```bash
npx scavi check
```

Available commands:

```bash
scavi init
scavi check
scavi check --format json
scavi fix
```

Deterministic checks are local and require no API key. Optional semantic verification supports OpenAI and local Ollama providers and is disabled by default.

Documentation and source: https://github.com/hsr88/scavi
