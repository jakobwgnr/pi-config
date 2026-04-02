# Pi Config

This repository provides Pi Coding Agent extensions for agent/LLM orchestration and robust file-based todos.

## Layout & Structure

- `extensions/agent-team/` — Agent team dispatcher/grid. Entrypoint: `index.ts`, main implementation in `src/index.ts`.
- `extensions/todos/` — Visual todo manager & file-based todo system. Entrypoint: `index.ts`, main implementation in `src/index.ts`.
- `extensions/shared/todo-helpers.ts` — (Optional) Library of shared helpers for todo file parsing/querying. **Note:** Most logic still lives in each extension; not all helpers are fully wired in.

Extension entrypoint (`index.ts`) files are thin wrappers for the actual implementation now found in `src/index.ts`.

## Features

### agent-team
- Widget grid display of all agents on the active team.
- **Each agent card shows that agent's current todos:** assigned todos first, or open/unassigned if none.
- Compact todo stats/indicators per agent, more details on expand.
- All team dispatch/command features are present.

### todos
- Powerful file-based todo system: frontmatter+markdown, assignment, locks, robust lifecycle.
- Visual filter/search/selection; full lifecycle (create, claim, refine, close, delete).
- CLI and agent/automation tool support.

### Shared helpers
- `extensions/shared/todo-helpers.ts` contains some common helpers for repeated file/query logic. As of this version, each extension mainly uses its own code for core functionality; helpers are not fully integrated everywhere.

## Contribution & Maintenance
- Add new shared logic to `extensions/shared/todo-helpers.ts` if it is generic and safe across both extensions.
- No dependencies required; all logic is local, no node_modules or package installs needed for basic extension usage.

## Implementation Philosophy
- Working functionality comes first. Shared code is promising but subordinate to extension correctness and stability.
