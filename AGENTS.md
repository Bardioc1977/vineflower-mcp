# Repository Guidelines

## Project Structure & Module Organization
- `src/server.ts` contains the MCP stdio server and all tool logic (plan, decompile, index).
- `dist/` is the compiled JavaScript output from TypeScript (`npm run build`).
- `README.md` documents usage, environment variables, and example tool calls.
- No dedicated test or assets directories exist in this repo.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run the MCP server via `tsx` for local development.
- `npm run build`: compile TypeScript to `dist/` with `tsc`.
- `npm run start`: run the compiled server from `dist/server.js`.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM) targeting NodeNext/ES2022.
- Indentation: 2 spaces (match existing files).
- Naming: camelCase for functions/variables, PascalCase for types/classes, kebab-case for filenames.
- Formatting: no formatter/linter is configured. Keep edits small and consistent with existing style.

## Testing Guidelines
- There is no test framework configured.
- If you add tests, document how to run them and add a script in `package.json` (e.g., `npm test`).

## Commit & Pull Request Guidelines
- No commit history conventions are defined in this repo.
- Use clear, imperative commit messages (e.g., "Add Vineflower stats output").
- PRs should include a concise summary, relevant command output (build/run), and any config changes.

## Security & Configuration Tips
- The server enforces a root sandbox via `MCP_ALLOWED_ROOT` (defaults to the repo root).
- Vineflower settings are configured by env vars such as `VINEFLOWER_BIN`, `VINEFLOWER_THREADS`,
  `MCP_TIMEOUT_MS`, and `MCP_MAX_CAPTURE_CHARS`. Document new env vars in `README.md`.
