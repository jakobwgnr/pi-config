/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md,
 * and ~/.pi/agent/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /agents-team          — switch active team
 *   /agents-list          — list loaded agents
 *   /agents-grid N        — set column count (default 2)
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ── Types ────────────────────────────────────────

type SystemPromptType = "append" | "replace";

interface AgentDef {
  name: string;
  description: string;
  tools: string;
  systemPrompt: string;
  customSystemPrompt: string;
  systemPromptType: SystemPromptType;
  file: string;
}

interface AgentState {
  def: AgentDef;
  status: "idle" | "running" | "done" | "error" | "disabled";
  task: string;
  toolCount: number;
  elapsed: number;
  lastWork: string;
  contextPct: number;
  sessionFile: string | null;
  runCount: number;
  timer?: ReturnType<typeof setInterval>;
}

interface AgentWidgetState {
  selectedIndex: number;
  expandedAgent: string | null;
}


// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
  const teams: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    const teamMatch = line.match(/^(\S[^:]*):$/);
    if (teamMatch) {
      current = teamMatch[1].trim();
      teams[current] = [];
      continue;
    }
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch && current) {
      teams[current].push(itemMatch[1].trim());
    }
  }
  return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseSimpleYamlFrontmatter(raw: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) return null;

    const idx = line.indexOf(":");
    if (idx <= 0) return null;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (value === "|" || value === ">") {
      const blockLines: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const blockLine = lines[i];
        if (!blockLine.trim()) {
          blockLines.push("");
          continue;
        }
        if (!/^\s+/.test(blockLine)) {
          i--;
          break;
        }
        blockLines.push(blockLine.replace(/^\s{1,2}/, ""));
      }
      value =
        value === ">"
          ? blockLines
              .join("\n")
              .split("\n\n")
              .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
              .join("\n\n")
          : blockLines.join("\n");
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function parseSystemPromptType(value?: string): SystemPromptType {
  return value === "append" ? "append" : "replace";
}

function buildAgentSystemPrompt(def: Pick<AgentDef, "customSystemPrompt" | "systemPrompt">): string {
  return [def.customSystemPrompt, def.systemPrompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function parseAgentFile(filePath: string): AgentDef | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = parseSimpleYamlFrontmatter(match[1]);
    if (!frontmatter?.name) return null;

    return {
      name: frontmatter.name,
      description: frontmatter.description || "",
      tools: frontmatter.tools || "read,grep,find,ls",
      systemPrompt: match[2].trim(),
      customSystemPrompt: (frontmatter["system-prompt"] || "").trim(),
      systemPromptType: parseSystemPromptType(frontmatter["system-prompt-type"]),
      file: filePath,
    };
  } catch {
    return null;
  }
}

function scanAgentDirs(cwd: string): AgentDef[] {
  const dirs = [
    join(cwd, "agents"),
    join(cwd, ".claude", "agents"),
    join(cwd, ".pi", "agents"),
    join(homedir(), ".pi", "agent", "agents"),
  ];

  const agents: AgentDef[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const fullPath = resolve(dir, file);
        const def = parseAgentFile(fullPath);
        if (def && !seen.has(def.name.toLowerCase())) {
          seen.add(def.name.toLowerCase());
          agents.push(def);
        }
      }
    } catch {}
  }

  return agents;
}

function findTeamsPath(cwd: string): string | null {
  const localTeamsPath = join(cwd, ".pi", "agents", "teams.yaml");
  if (existsSync(localTeamsPath)) return localTeamsPath;

  const globalTeamsPath = join(
    homedir(),
    ".pi",
    "agent",
    "agents",
    "teams.yaml",
  );
  if (existsSync(globalTeamsPath)) return globalTeamsPath;

  return null;
}

function formatTeamsSource(cwd: string, teamsPath: string | null): string {
  if (!teamsPath) return "generated default team";
  return teamsPath === join(cwd, ".pi", "agents", "teams.yaml")
    ? ".pi/agents/teams.yaml"
    : "~/.pi/agent/agents/teams.yaml";
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agentStates: Map<string, AgentState> = new Map();
  let allAgentDefs: AgentDef[] = [];
  let teams: Record<string, string[]> = {};
  let activeTeamName = "";
  let gridCols = 2;
  let widgetCtx: any;
  let sessionDir = "";
  let contextWindow = 0;
  let isActive = true;
  let previousActiveTools: string[] | null = null;
  let teamsSource = "generated default team";
  const widgetState: AgentWidgetState = {
    selectedIndex: 0,
    expandedAgent: null,
  };

  function loadAgents(cwd: string) {
    // Create session storage dir
    sessionDir = join(cwd, ".pi", "agent-sessions");
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Load all agent definitions
    allAgentDefs = scanAgentDirs(cwd);

    // Load teams from project-local or global config
    const teamsPath = findTeamsPath(cwd);
    teamsSource = formatTeamsSource(cwd, teamsPath);
    if (teamsPath) {
      try {
        teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
      } catch {
        teams = {};
      }
    } else {
      teams = {};
    }

    // If no teams defined, create a default "all" team
    if (Object.keys(teams).length === 0) {
      teams = { all: allAgentDefs.map((d) => d.name) };
    }
  }

  function activateTeam(teamName: string) {
    activeTeamName = teamName;
    const members = teams[teamName] || [];
    const defsByName = new Map(
      allAgentDefs.map((d) => [d.name.toLowerCase(), d]),
    );

    agentStates.clear();
    for (const member of members) {
      const def = defsByName.get(member.toLowerCase());
      if (!def) continue;
      const key = def.name.toLowerCase().replace(/\s+/g, "-");
      const sessionFile = join(sessionDir, `${key}.json`);
      agentStates.set(def.name.toLowerCase(), {
        def,
        status: "idle",
        task: "",
        toolCount: 0,
        elapsed: 0,
        lastWork: "",
        contextPct: 0,
        sessionFile: existsSync(sessionFile) ? sessionFile : null,
        runCount: 0,
      });
    }

    // Auto-size grid columns based on team size
    const size = agentStates.size;
    gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
    widgetState.selectedIndex = 0;
    widgetState.expandedAgent = null;
  }

  // ── Grid Rendering ───────────────────────────

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function truncateLine(text: string, width: number): string {
    if (width <= 0) return "";
    if (text.length <= width) return text;
    if (width <= 3) return ".".repeat(width);
    return text.slice(0, width - 3) + "...";
  }

  function wrapText(text: string, width: number, maxLines: number): string[] {
    if (width <= 0 || maxLines <= 0) return [];

    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return [""];

    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      if (!current) {
        current = word.length > width ? truncateLine(word, width) : word;
        continue;
      }

      if (`${current} ${word}`.length <= width) {
        current += ` ${word}`;
        continue;
      }

      lines.push(current);
      if (lines.length === maxLines) {
        return lines;
      }
      current = word.length > width ? truncateLine(word, width) : word;
    }

    if (lines.length < maxLines && current) {
      lines.push(current);
    }

    if (lines.length > maxLines) {
      return lines.slice(0, maxLines);
    }

    return lines;
  }

  function getStatusColor(status: AgentState["status"]): string {
    return status === "idle"
      ? "dim"
      : status === "running"
        ? "accent"
        : status === "done"
          ? "success"
          : status === "disabled"
            ? "muted"
            : "error";
  }

  function getStatusIcon(status: AgentState["status"]): string {
    return status === "idle"
      ? "○"
      : status === "running"
        ? "●"
        : status === "done"
          ? "✓"
          : status === "disabled"
            ? "⏸"
            : "✗";
  }

  function getContextBar(state: AgentState): string {
    const filled = clamp(Math.ceil(state.contextPct / 20), 0, 5);
    const bar = "#".repeat(filled) + "-".repeat(5 - filled);
    return `[${bar}] ${Math.ceil(state.contextPct)}%`;
  }

  function getAgentDetailLines(state: AgentState, contentWidth: number): string[] {
    const description = truncateLine(state.def.description || "No description", contentWidth);
    const task = truncateLine(state.task || "Waiting for work", contentWidth);
    const currentWork = truncateLine(
      state.status === "running"
        ? state.lastWork || state.task || "Working..."
        : state.lastWork || "No recent output",
      contentWidth,
    );
    const tools = truncateLine(`Tools: ${state.def.tools}`, contentWidth);
    const runs = truncateLine(
      `Runs: ${state.runCount} · Session: ${state.sessionFile ? "resume" : "new"}`,
      contentWidth,
    );

    const detailLines = [
      `Role: ${description}`,
      `Task: ${task}`,
      `Doing: ${currentWork}`,
      tools,
      runs,
    ];

    if (state.def.customSystemPrompt) {
      detailLines.push("Custom system prompt configured ✓");
    }

    return detailLines.flatMap((line) => wrapText(line, contentWidth, 2));
  }

  function renderCard(
    state: AgentState,
    colWidth: number,
    theme: any,
    options: { expanded: boolean; selected: boolean },
  ): string[] {
    const w = Math.max(8, colWidth - 2);
    const statusColor = getStatusColor(state.status);
    const statusIcon = getStatusIcon(state.status);

    const topBorderColor = options.selected || options.expanded ? "accent" : "dim";
    const sideBorderColor = options.selected || options.expanded ? "accent" : "dim";

    const top = "┌" + "─".repeat(w) + "┐";
    const bot = "└" + "─".repeat(w) + "┘";
    const border = (content: string, visibleLength: number) =>
      theme.fg(sideBorderColor, "│") +
      content +
      " ".repeat(Math.max(0, w - visibleLength)) +
      theme.fg(sideBorderColor, "│");

    const lines = [theme.fg(topBorderColor, top)];

    const namePrefix = options.expanded ? "▼ " : options.selected ? "▸ " : "  ";
    const nameText = truncateLine(namePrefix + displayName(state.def.name), w - 1);
    lines.push(
      border(
        " " + theme.fg("accent", theme.bold(nameText)),
        1 + nameText.length,
      ),
    );

    const statusStr = `${statusIcon} ${state.status}${state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : ""}`;
    const statusText = truncateLine(statusStr, w - 1);
    lines.push(border(" " + theme.fg(statusColor, statusText), 1 + statusText.length));

    const ctxStr = getContextBar(state);
    lines.push(border(" " + theme.fg("dim", ctxStr), 1 + ctxStr.length));

    const summaryLabel = state.status === "running" ? "Doing" : "Summary";
    const summaryRaw = state.status === "running"
      ? state.lastWork || state.task || "Working..."
      : state.task
        ? state.lastWork || state.task
        : state.def.description;
    const summaryLine = truncateLine(`${summaryLabel}: ${summaryRaw}`, w - 1);
    lines.push(border(" " + theme.fg("muted", summaryLine), 1 + summaryLine.length));

    if (options.expanded) {
      for (const detail of getAgentDetailLines(state, w - 1)) {
        lines.push(border(" " + theme.fg("muted", detail), 1 + detail.length));
      }
    } else if (state.def.customSystemPrompt) {
      const promptText = truncateLine("Custom system prompt ✓", w - 1);
      lines.push(border(" " + theme.fg("success", promptText), 1 + promptText.length));
    }

    lines.push(theme.fg(topBorderColor, bot));
    return lines;
  }

  function handleWidgetNavigationInput(keyData: string): boolean {
    const agents = Array.from(agentStates.values());
    if (agents.length === 0) return false;

    if (matchesKey(keyData, Key.ctrl("space"))) {
      if (widgetState.expandedAgent) {
        widgetState.expandedAgent = null;
      } else {
        const selectedAgent = agents[widgetState.selectedIndex];
        if (selectedAgent) {
          widgetState.expandedAgent = selectedAgent.def.name;
        }
      }
      return true;
    }

    if (widgetState.expandedAgent) return false;

    const cols = Math.min(gridCols, agents.length);
    const previousIndex = widgetState.selectedIndex;
    const moveUp = keyData === "\u001b[1;5A";
    const moveDown = keyData === "\u001b[1;5B";
    const moveLeft = keyData === "\u001b[1;5D";
    const moveRight = keyData === "\u001b[1;5C";

    if (moveUp) {
      widgetState.selectedIndex = clamp(widgetState.selectedIndex - cols, 0, agents.length - 1);
    } else if (moveDown) {
      widgetState.selectedIndex = clamp(widgetState.selectedIndex + cols, 0, agents.length - 1);
    } else if (moveLeft) {
      widgetState.selectedIndex = clamp(widgetState.selectedIndex - 1, 0, agents.length - 1);
    } else if (moveRight) {
      widgetState.selectedIndex = clamp(widgetState.selectedIndex + 1, 0, agents.length - 1);
    } else {
      return false;
    }

    return widgetState.selectedIndex !== previousIndex;
  }

  function clearWidgetAndFooter(ctx = widgetCtx) {
    if (!ctx) return;
    ctx.ui.setWidget("agent-team", undefined);
    ctx.ui.setFooter(undefined);
  }

  function setFooter(ctx = widgetCtx) {
    if (!ctx) return;
    ctx.ui.setFooter((_tui, theme, _footerData) => ({
      dispose: () => {},
      invalidate() {},
      render(width: number): string[] {
        if (!isActive) {
          return [truncateToWidth("", width)];
        }

        const model = ctx.model?.id || "no-model";
        const usage = ctx.getContextUsage();
        const pct = usage ? usage.percent : 0;
        const filled = Math.round(pct / 10);
        const bar = "#".repeat(filled) + "-".repeat(10 - filled);

        const left =
          theme.fg("dim", ` ${model}`) +
          theme.fg("muted", " · ") +
          theme.fg("accent", activeTeamName);
        const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
        const pad = " ".repeat(
          Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
        );

        return [truncateToWidth(left + pad + right, width)];
      },
    }));
  }

  function updateStatus(ctx = widgetCtx) {
    if (!ctx) return;
    ctx.ui.setStatus(
      "agent-team",
      isActive
        ? `Team: ${activeTeamName} (${agentStates.size})`
        : "Team: disabled",
    );
  }

  function updateWidget() {
    if (!widgetCtx || !isActive) return;

    widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
      const text = new Text("", 0, 1);

      return {
        render(width: number): string[] {
          if (agentStates.size === 0) {
            text.setText(
              theme.fg(
                "dim",
                "No agents found. Add .md files to agents/, .pi/agents/, or ~/.pi/agent/agents/",
              ),
            );
            return text.render(width);
          }

          const allAgents = Array.from(agentStates.values());
          if (widgetState.selectedIndex >= allAgents.length) {
            widgetState.selectedIndex = Math.max(0, allAgents.length - 1);
          }

          const agents = widgetState.expandedAgent
            ? allAgents.filter((agent) => agent.def.name === widgetState.expandedAgent)
            : allAgents;

          const cols = widgetState.expandedAgent ? 1 : Math.min(gridCols, agents.length);
          const gap = 1;
          const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
          const rows: string[][] = [];

          for (let i = 0; i < agents.length; i += cols) {
            const rowAgents = agents.slice(i, i + cols);
            const cards = rowAgents.map((agent) => {
              const selectedAgent = allAgents[widgetState.selectedIndex];
              return renderCard(agent, colWidth, theme, {
                expanded: widgetState.expandedAgent === agent.def.name,
                selected: !widgetState.expandedAgent && selectedAgent?.def.name === agent.def.name,
              });
            });

            const cardHeight = Math.max(...cards.map((card) => card.length));

            while (cards.length < cols) {
              cards.push(Array(cardHeight).fill(" ".repeat(colWidth)));
            }
            for (let line = 0; line < cardHeight; line++) {
              rows.push(cards.map((card) => card[line] || ""));
            }
          }

          const controls = widgetState.expandedAgent
            ? theme.fg("dim", "Ctrl+Space to collapse")
            : theme.fg("dim", "Ctrl+Arrow to navigate · Ctrl+Space to expand");
          const output = rows.map((columns) => columns.join(" ".repeat(gap)));
          text.setText(output.concat(["", controls]).join("\n"));
          return text.render(width);
        },
        invalidate() {
          text.invalidate();
        },
        handleInput(keyData: string) {
          const handled = handleWidgetNavigationInput(keyData);
          if (handled) {
            text.invalidate();
            updateWidget();
          }
        },
      };
    });
  }

  function enableAgentTeam(ctx = widgetCtx) {
    if (!ctx) return;

    widgetCtx = ctx;
    isActive = true;
    loadAgents(ctx.cwd);

    const teamNames = Object.keys(teams);
    if (teamNames.length > 0) {
      activateTeam(teams[activeTeamName] ? activeTeamName : teamNames[0]);
    } else {
      activeTeamName = "";
      agentStates.clear();
    }

    pi.setActiveTools(["dispatch_agent"]);
    updateStatus(ctx);
    updateWidget();
    setFooter(ctx);
  }

  // ── Dispatch Agent (returns Promise) ─────────

  function dispatchAgent(
    agentName: string,
    task: string,
    ctx: any,
  ): Promise<{ output: string; exitCode: number; elapsed: number }> {
    if (!isActive) {
      return Promise.resolve({
        output:
          "Agent team is deactivated. dispatch_agent is unavailable for this session.",
        exitCode: 1,
        elapsed: 0,
      });
    }

    const key = agentName.toLowerCase();
    const state = agentStates.get(key);
    if (!state) {
      return Promise.resolve({
        output: `Agent "${agentName}" not found. Available: ${Array.from(
          agentStates.values(),
        )
          .map((s) => displayName(s.def.name))
          .join(", ")}`,
        exitCode: 1,
        elapsed: 0,
      });
    }

    if (state.status === "running") {
      return Promise.resolve({
        output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
        exitCode: 1,
        elapsed: 0,
      });
    }

    state.status = "running";
    state.task = task;
    state.toolCount = 0;
    state.elapsed = 0;
    state.lastWork = "";
    state.runCount++;
    updateWidget();

    const startTime = Date.now();
    state.timer = setInterval(() => {
      state.elapsed = Date.now() - startTime;
      updateWidget();
    }, 1000);

    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "openrouter/google/gemini-3-flash-preview";

    // Session file for this agent
    const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
    const agentSessionFile = join(sessionDir, `${agentKey}.json`);

    // Build args — first run creates session, subsequent runs resume
    const agentSystemPrompt = buildAgentSystemPrompt(state.def);

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
      "--model",
      model,
      "--tools",
      state.def.tools,
      "--thinking",
      "off",
      state.def.systemPromptType === "append"
        ? "--append-system-prompt"
        : "--system-prompt",
      agentSystemPrompt,
      "--session",
      agentSessionFile,
    ];

    // Continue existing session if we have one
    if (state.sessionFile) {
      args.push("-c");
    }

    args.push(task);

    const textChunks: string[] = [];

    return new Promise((resolve) => {
      const proc = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let buffer = "";

      proc.stdout!.setEncoding("utf-8");
      proc.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta?.type === "text_delta") {
                textChunks.push(delta.delta || "");
                const full = textChunks.join("");
                const last =
                  full
                    .split("\n")
                    .filter((l: string) => l.trim())
                    .pop() || "";
                state.lastWork = last;
                updateWidget();
              }
            } else if (event.type === "tool_execution_start") {
              state.toolCount++;
              updateWidget();
            } else if (event.type === "message_end") {
              const msg = event.message;
              if (msg?.usage && contextWindow > 0) {
                state.contextPct =
                  ((msg.usage.input || 0) / contextWindow) * 100;
                updateWidget();
              }
            } else if (event.type === "agent_end") {
              const msgs = event.messages || [];
              const last = [...msgs]
                .reverse()
                .find((m: any) => m.role === "assistant");
              if (last?.usage && contextWindow > 0) {
                state.contextPct =
                  ((last.usage.input || 0) / contextWindow) * 100;
                updateWidget();
              }
            }
          } catch {}
        }
      });

      proc.stderr!.setEncoding("utf-8");
      proc.stderr!.on("data", () => {});

      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta?.type === "text_delta")
                textChunks.push(delta.delta || "");
            }
          } catch {}
        }

        clearInterval(state.timer);
        state.elapsed = Date.now() - startTime;
        state.status = isActive ? (code === 0 ? "done" : "error") : "disabled";

        // Mark session file as available for resume
        if (code === 0) {
          state.sessionFile = agentSessionFile;
        }

        const full = textChunks.join("");
        state.lastWork =
          full
            .split("\n")
            .filter((l: string) => l.trim())
            .pop() || "";
        updateWidget();
        if (!isActive) {
          clearWidgetAndFooter(ctx);
          updateStatus(ctx);
        }

        ctx.ui.notify(
          `${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
          state.status === "done" ? "success" : "error",
        );

        resolve({
          output: full,
          exitCode: code ?? 1,
          elapsed: state.elapsed,
        });
      });

      proc.on("error", (err) => {
        clearInterval(state.timer);
        state.status = isActive ? "error" : "disabled";
        state.lastWork = `Error: ${err.message}`;
        updateWidget();
        if (!isActive) {
          clearWidgetAndFooter(ctx);
          updateStatus(ctx);
        }
        resolve({
          output: `Error spawning agent: ${err.message}`,
          exitCode: 1,
          elapsed: Date.now() - startTime,
        });
      });
    });
  }

  // ── dispatch_agent Tool (registered at top level) ──

  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive)" }),
      task: Type.String({
        description: "Task description for the agent to execute",
      }),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { agent, task } = params as { agent: string; task: string };

      try {
        if (!isActive) {
          return {
            content: [
              {
                type: "text",
                text: "Agent team is deactivated. dispatch_agent is unavailable for this session.",
              },
            ],
            details: {
              agent,
              task,
              status: "error",
              elapsed: 0,
              exitCode: 1,
              fullOutput: "",
            },
          };
        }

        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: `Dispatching to ${agent}...` }],
            details: { agent, task, status: "dispatching" },
          });
        }

        const result = await dispatchAgent(agent, task, ctx);

        const truncated =
          result.output.length > 8000
            ? result.output.slice(0, 8000) + "\n\n... [truncated]"
            : result.output;

        const status = result.exitCode === 0 ? "done" : "error";
        const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

        return {
          content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
          details: {
            agent,
            task,
            status,
            elapsed: result.elapsed,
            exitCode: result.exitCode,
            fullOutput: result.output,
          },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error dispatching to ${agent}: ${err?.message || err}`,
            },
          ],
          details: {
            agent,
            task,
            status: "error",
            elapsed: 0,
            exitCode: 1,
            fullOutput: "",
          },
        };
      }
    },

    renderCall(args, theme) {
      const agentName = (args as any).agent || "?";
      const task = (args as any).task || "";
      const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
          theme.fg("accent", agentName) +
          theme.fg("dim", " — ") +
          theme.fg("muted", preview),
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      // Streaming/partial result while agent is still running
      if (options.isPartial || details.status === "dispatching") {
        return new Text(
          theme.fg("accent", `● ${details.agent || "?"}`) +
            theme.fg("dim", " working..."),
          0,
          0,
        );
      }

      const icon = details.status === "done" ? "✓" : "✗";
      const color = details.status === "done" ? "success" : "error";
      const elapsed =
        typeof details.elapsed === "number"
          ? Math.round(details.elapsed / 1000)
          : 0;
      const header =
        theme.fg(color, `${icon} ${details.agent}`) +
        theme.fg("dim", ` ${elapsed}s`);

      if (options.expanded && details.fullOutput) {
        const output =
          details.fullOutput.length > 4000
            ? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
            : details.fullOutput;
        return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
      }

      return new Text(header, 0, 0);
    },
  });

  // ── Commands ─────────────────────────────────

  pi.registerCommand("agents-team", {
    description: "Select a team to work with",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      if (!isActive) {
        return "Agent team is deactivated for this session.";
      }
      const teamNames = Object.keys(teams);
      if (teamNames.length === 0) {
        ctx.ui.notify(
          "No teams defined in .pi/agents/teams.yaml or ~/.pi/agent/agents/teams.yaml",
          "warning",
        );
        return;
      }

      const options = teamNames.map((name) => {
        const members = teams[name].map((m) => displayName(m));
        return `${name} — ${members.join(", ")}`;
      });

      const choice = await ctx.ui.select("Select Team", options);
      if (choice === undefined) return;

      const idx = options.indexOf(choice);
      const name = teamNames[idx];
      activateTeam(name);
      updateWidget();
      updateStatus(ctx);
      ctx.ui.notify(
        `Team: ${name} — ${Array.from(agentStates.values())
          .map((s) => displayName(s.def.name))
          .join(", ")}`,
        "info",
      );
    },
  });

  pi.registerCommand("agents-list", {
    description: "List all loaded agents",
    handler: async (_args, _ctx) => {
      widgetCtx = _ctx;
      if (!isActive) {
        return "Agent team is deactivated for this session.";
      }
      const names = Array.from(agentStates.values())
        .map((s) => {
          const session = s.sessionFile ? "resumed" : "new";
          return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
        })
        .join("\n");
      _ctx.ui.notify(names || "No agents loaded", "info");
    },
  });

  pi.registerCommand("agents-grid", {
    description: "Set grid columns: /agents-grid <1-6>",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = ["1", "2", "3", "4", "5", "6"].map((n) => ({
        value: n,
        label: `${n} columns`,
      }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : items;
    },
    handler: async (args, _ctx) => {
      widgetCtx = _ctx;
      if (!isActive) {
        return "Agent team is deactivated for this session.";
      }
      const n = parseInt(args?.trim() || "", 10);
      if (n >= 1 && n <= 6) {
        gridCols = n;
        _ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
        updateWidget();
      } else {
        _ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
      }
    },
  });


  pi.registerCommand("agents-team:deactivate", {
    description: "Deactivate agent-team for the current session",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      isActive = false;

      for (const state of agentStates.values()) {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = undefined;
        }
        state.status = "disabled";
      }

      const restoredTools =
        previousActiveTools && previousActiveTools.length > 0
          ? previousActiveTools
          : pi.getAllTools().map((t) => t.name);
      pi.setActiveTools(restoredTools);

      clearWidgetAndFooter(ctx);
      updateStatus(ctx);
      ctx.ui.notify("Agent team deactivated for this session", "info");
      return "Agent team deactivated for this session.";
    },
  });

  pi.registerCommand("agents-team:activate", {
    description: "Activate agent-team for the current session",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      if (isActive) {
        return "Agent team is already active for this session.";
      }

      enableAgentTeam(ctx);

      const members = Array.from(agentStates.values())
        .map((s) => displayName(s.def.name))
        .join(", ");
      ctx.ui.notify(
        `Agent team activated for this session\n` +
          `Team: ${activeTeamName} (${members})\n` +
          `Team sets loaded from: ${teamsSource}`,
        "info",
      );
      return "Agent team activated for this session.";
    },
  });

  // ── System Prompt Override ───────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!isActive) return;

    // Build dynamic agent catalog from active team only
    const agentCatalog = Array.from(agentStates.values())
      .map(
        (s) =>
          `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`,
      )
      .join("\n\n");

    const teamMembers = Array.from(agentStates.values())
      .map((s) => displayName(s.def.name))
      .join(", ");

    return {
      systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using the dispatch_agent tool
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
    };
  });

  // ── Session Start ────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Clear widgets from previous session
    if (widgetCtx) {
      widgetCtx.ui.setWidget("agent-team", undefined);
    }
    widgetCtx = _ctx;
    contextWindow = _ctx.model?.contextWindow || 0;
    isActive = true;

    // Wipe old agent session files so subagents start fresh
    const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
    if (existsSync(sessDir)) {
      for (const f of readdirSync(sessDir)) {
        if (f.endsWith(".json")) {
          try {
            unlinkSync(join(sessDir, f));
          } catch {}
        }
      }
    }

    previousActiveTools = pi.getActiveTools();
    enableAgentTeam(_ctx);

    const members = Array.from(agentStates.values())
      .map((s) => displayName(s.def.name))
      .join(", ");
    _ctx.ui.notify(
      `Team: ${activeTeamName} (${members})\n` +
        `Team sets loaded from: ${teamsSource}\n\n` +
        `/agents-team          Select a team\n` +
        `/agents-team:activate Activate agent-team for this session\n` +
        `/agents-team:deactivate Disable agent-team for this session\n` +
        `/agents-list          List active agents and status\n` +
        `/agents-grid <1-6>    Set grid column count`,
      "info",
    );
    updateWidget();
  });
}
