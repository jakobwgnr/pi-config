# Pi Config

My personal [pi](https://github.com/badlogic/pi) configuration — agents, skills, extensions, and prompts that shape how pi works for me.

## Setup

Clone this repo directly to `~/.pi/agent/` — pi auto-discovers everything from there (extensions, skills, agents, AGENTS.md, mcp.json). No symlinks, no manual wiring.

### Fresh machine

```bash
# 1. Install pi (https://github.com/badlogic/pi)

# 2. Clone this repo as your agent config
mkdir -p ~/.pi
git clone https://github.com/jakobwgnr/pi-config.git ~/.pi/agent

# 3. Run setup (installs packages + extension deps)
cd ~/.pi/agent && sudo bash ./setup.sh

# 4. Add your API keys to ~/.pi/agent/auth.json

# 5. Restart pi
```

### Updating

```bash
cd ~/.pi/agent && git pull
```

---

## Architecture

This config uses **subagents** — visible pi sessions with their own identity, tools, and skills. The user can watch agents work in real time and interact when needed.

### Key Concepts

- **Subagents** —  Autonomous agents self-terminate via `subagent_done`. Interactive agents wait for the user.
- **Agent definitions** (`agents/*.md`) — one source of truth for model, tools, skills, and identity per role.
- **Plan workflow** — `/plan` spawns an interactive planner subagent, then orchestrates workers and reviewers.
- **Iterate pattern** — `/iterate` forks the session into a subagent for quick fixes without polluting the main context.

---

## Agents

Specialized roles with baked-in identity, workflow, and review rubrics.

| Agent | Model | Purpose |
|-------|-------|---------|
| **planner** | gpt-5.4 | Interactive brainstorming — clarify, explore, validate design, write plan, create todos |
| **scout** | gpt-4.1 | Fast codebase reconnaissance — gathers context without making changes |
| **worker** | gpt-4.1 | Implements tasks from todos, commits with polished messages |
| **reviewer** | gpt-5.4 | Reviews code for quality, security, correctness (review rubric baked in) |
| **researcher** | gpt-5.4 | Deep research using parallel.ai tools + Claude Code for code analysis |
| **visual-tester** | gpt-4.1 | Visual QA for web UIs using Chrome CDP tooling |
| **etl-development-expert** | gpt-5.4 | Implements ETL processes from approved mappings, including Rogue-based ETL repositories |

`agents/autoresearch.md` is present as an experimental agent definition, but it depends on custom experiment tools that are not provisioned by this repo.

## Skills

Loaded on-demand when the context matches.

| Skill | When to Load |
|-------|-------------|
| **commit** | Making git commits (mandatory for every commit) |
| **code-simplifier** | Simplifying or cleaning up code |
| **frontend-design** | Building web components, pages, or apps |
| **learn-codebase** | Onboarding to a new project, checking conventions |
| **session-reader** | Reading and analyzing pi session JSONL files |
| **skill-creator** | Scaffolding new agent skills |
| **add-mcp-server** | Adding MCP server configurations |
| **plan** | Running the planner-led planning workflow |
| **rogue** | Inspecting Rogue job repositories with `rogue/` jobs and `templates/` templates |

## Local Extensions

| Extension | What it provides |
|-----------|------------------|
| **answer/** | `/answer` command + `Ctrl+.` — extracts questions into interactive Q&A UI |
| **execute-command/** | `execute_command` tool — lets the agent self-invoke slash commands |
| **todos/** | `/todos` command + `todo` tool — file-based todo management |
| **cost/** | `/cost` command — API cost summary |
| **watchdog/** | Monitors agent behavior |
| **agent-team/** | Dispatcher-only orchestrator that loads team definitions from `teams.yaml` and agent definitions from project and global pi agent directories |

## Package-Provided Capabilities

Installed by `setup.sh` and managed in `settings.json`.

| Package | What it provides |
|---------|------------------|
| **pi-subagents** | `subagent` tool + `/plan`, `/subagent`, `/iterate` commands and session-scoped artifacts |
| **pi-mcp-adapter** | MCP adapter integration |
| **pi-powerline-footer** | Powerline-style footer UI |
| **pi-smart-sessions** | AI-generated session names |
| **pi-markdown-preview** | Markdown preview support |
| **pi-guardrails** | Additional runtime guardrails |
| **pi-notify** | Notifications integration |
| **chrome-cdp-skill** | Chrome DevTools Protocol CLI for visual testing |

## Agent Discovery

Pi auto-discovers agent definitions in this repo's `agents/` directory. The `agent-team` extension also loads agent definitions from project-local `.pi/agents/` and global `~/.pi/agent/agents/`, mirroring how it already falls back to the global `teams.yaml`.

## Commands

| Command | Description |
|---------|-------------|
| `/plan <description>` | Start a planning session — spawns planner subagent, then orchestrates execution |
| `/subagent <agent> <task>` | Spawn a subagent (e.g., `/subagent scout analyze the auth module`) |
| `/iterate [task]` | Fork session into interactive subagent for quick fixes |
| `/answer` | Extract questions into interactive Q&A |
| `/todos` | Visual todo manager |
| `/cost` | API cost summary |
| `/watchdog [off|on|<minutes>]` | Toggle the watchdog or set its intervention interval |

## Package Sources

| Package | Source |
|---------|--------|
| **pi-subagents** | https://github.com/nicobailon/pi-subagents |
| **pi-mcp-adapter** | https://github.com/nicobailon/pi-mcp-adapter |
| **pi-powerline-footer** | https://github.com/nicobailon/pi-powerline-footer |
| **pi-smart-sessions** | https://github.com/HazAT/pi-smart-sessions |
| **pi-markdown-preview** | https://github.com/omaclaren/pi-markdown-preview |
| **pi-guardrails** | https://github.com/aliou/pi-guardrails |
| **pi-notify** | https://github.com/arosstale/pi-notify |
| **chrome-cdp-skill** | https://github.com/pasky/chrome-cdp-skill |

---

## Credits
Inspiration from [hazAT/pi-config](https://github.com/HazAT/pi-config)

Extensions from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `answer.ts`, `todos.ts`

Skills from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `commit`

Skills from [getsentry/skills](https://github.com/getsentry/skills): `code-simplifier`