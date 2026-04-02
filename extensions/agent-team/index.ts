/*
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
  model: string;
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
      model: (frontmatter.model || "").trim(),
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

  function loadAgents(cwd: string) {
    sessionDir = join(cwd, ".pi", "agent-sessions");
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    allAgentDefs = scanAgentDirs(cwd);
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
    if (Object.keys(teams).length === 0) {
      teams = { all: allAgentDefs.map((d) => d.name) };
    }
  }

  function activateTeam(teamName: string) {
    activeTeamName = teamName;
    const members = teams[teamName] || [];
    const defsByName = new Map(allAgentDefs.map((d) => [d.name.toLowerCase(), d]));
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
    const size = agentStates.size;
    gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
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
    // --- Patch: Only single-line with ellipsis for display/truncate fields ---
    // This keeps display fields to a single line and truncates with ellipsis if wrapped.
    return [truncateLine(text.replace(/\s+/g, " ").trim(), width)];
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
    // REMOVE MODEL FROM DETAILS (Requirement 1)
    // const model = truncateLine(`Model: ${state.def.model || "session default"}`, contentWidth);
    const tools = truncateLine(`Tools: ${state.def.tools}`, contentWidth);
    const runs = truncateLine(
      `Runs: ${state.runCount} · Session: ${state.sessionFile ? "resume" : "new"}`,
      contentWidth,
    );
    const detailLines = [
      `Role: ${description}`,
      `Task: ${task}`,
      `Doing: ${currentWork}`,
      // model (REMOVED)
      tools,
      runs,
    ];
    // (Requirement 2) ONLY show custom system prompt status ONCE in the details—not again in card render
    if (state.def.customSystemPrompt) {
      detailLines.push("Custom system prompt configured ✓");
    }
    return detailLines.flatMap((line) => wrapText(line, contentWidth, 1));
  }
  function renderCard(
    state: AgentState,
    colWidth: number,
    theme: any,
  ): string[] {
    const w = Math.max(8, colWidth - 2);
    const statusColor = getStatusColor(state.status);
    const statusIcon = getStatusIcon(state.status);
    const topBorderColor = "dim";
    const sideBorderColor = "dim";
    const top = "┌" + "─".repeat(w) + "┐";
    const bot = "└" + "─".repeat(w) + "┘";
    const border = (content: string, visibleLength: number) =>
      theme.fg(sideBorderColor, "│") +
      content +
      " ".repeat(Math.max(0, w - visibleLength)) +
      theme.fg(sideBorderColor, "│");
    const lines = [theme.fg(topBorderColor, top)];
    // Model in header only (Requirement 1)
    const modelSuffix = state.def.model ? ` [${state.def.model}]` : "";
    const nameText = truncateToWidth(displayName(state.def.name) + modelSuffix, Math.max(1, w - 1));
    const headerContent = theme.fg("accent", theme.bold(nameText));
    lines.push(border(" " + headerContent, 1 + visibleWidth(headerContent)));
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
    for (const detail of getAgentDetailLines(state, w - 1)) {
      lines.push(border(" " + theme.fg("muted", detail), 1 + detail.length));
    }
    // (Requirement 2) Do NOT show custom system prompt status a second time here
    lines.push(theme.fg(topBorderColor, bot));
    return lines;
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
          const cols = Math.min(gridCols, allAgents.length);
          const gap = 1;
          const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
          const rows: string[][] = [];
          for (let i = 0; i < allAgents.length; i += cols) {
            const rowAgents = allAgents.slice(i, i + cols);
            const cards = rowAgents.map((agent) => renderCard(agent, colWidth, theme));
            const cardHeight = Math.max(...cards.map((card) => card.length));
            while (cards.length < cols) {
              cards.push(Array(cardHeight).fill(" ".repeat(colWidth)));
            }
            for (let line = 0; line < cardHeight; line++) {
              rows.push(cards.map((card) => card[line] || ""));
            }
          }
          const controls = theme.fg(
            "dim",
            "Grid view: /agents-grid <1-6> to change layout"
          );
          const output = rows.map((columns) => columns.join(" ".repeat(gap)));
          text.setText(output.concat(["", controls]).join("\n"));
          return text.render(width);
        },
        invalidate() {
          text.invalidate();
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
  // ... rest of file is unchanged and not UI related ...
}
