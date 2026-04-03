/*
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * instance has its own Pi session file (`{role}-1.jsonl`, `{role}-2.jsonl`, …)
 * so the same role can run in parallel.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md,
 * and ~/.pi/agent/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml (YAML). Members may be strings or
 * objects with optional name, path, color, consult-when, sequence. On boot a
 * select dialog lets you pick which team to work with. Only team members are
 * available for dispatch.
 *
 * Member object fields (optional): agent, path, name (card title), color (#RRGGBB),
 * consult-when, sequence (same sequence = same widget row; unsequenced = last row).
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";

// ── Types ────────────────────────────────────────

type SystemPromptType = "append" | "replace";

interface AgentDef {
  name: string;
  description: string;
  model: string;
  tools: string;
  /** Pi extensions loaded in the subagent via `-e` (slugs under project `extensions/`). */
  extensionSlugs: string[];
  systemPrompt: string;
  customSystemPrompt: string;
  systemPromptType: SystemPromptType;
  file: string;
}

type AgentStatus = "idle" | "running" | "done" | "error" | "disabled";

interface AgentInstanceState {
  instanceId: number;
  def: AgentDef;
  status: AgentStatus;
  task: string;
  toolCount: number;
  elapsed: number;
  lastWork: string;
  contextPct: number;
  /** Path to existing session for -c resume, or null for a fresh session file. */
  sessionFile: string | null;
  runCount: number;
  timer?: ReturnType<typeof setInterval>;
  /** Optional card title from teams.yaml `name`. */
  teamCardName?: string;
  /** Optional hex color for card header/border (#RRGGBB). */
  teamCardColor?: string;
  /** Orchestrator hint from teams.yaml `consult-when`. */
  teamConsultWhen?: string;
  /** From teams.yaml `sequence`; undefined = unsequenced tail group. */
  teamSequence?: number;
  /** YAML list order within the team. */
  teamOrder: number;
}

function agentLookupKey(def: AgentDef): string {
  return def.name.toLowerCase();
}

function agentFileKey(def: AgentDef): string {
  return def.name.toLowerCase().replace(/\s+/g, "-");
}

function initialSessionFileForInstance(
  sessionDir: string,
  fileKey: string,
  instanceId: number,
): string | null {
  const numbered = join(sessionDir, `${fileKey}-${instanceId}.jsonl`);
  if (existsSync(numbered)) return numbered;
  if (instanceId === 1) {
    const legacy = join(sessionDir, `${fileKey}.jsonl`);
    if (existsSync(legacy)) return legacy;
  }
  return null;
}

function sessionPathForSpawn(
  state: AgentInstanceState,
  sessionDir: string,
  fileKey: string,
): string {
  const numbered = join(sessionDir, `${fileKey}-${state.instanceId}.jsonl`);
  if (state.sessionFile) return state.sessionFile;
  return numbered;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Teams YAML ───────────────────────────────────

interface TeamMemberSpec {
  /** Scan lookup when `path` is not set. */
  agent?: string;
  /** Relative path to agent .md under project cwd. */
  path?: string;
  cardName?: string;
  color?: string;
  consultWhen?: string;
  sequence?: number;
  sourceOrder: number;
}

function isAbsolutePath(p: string): boolean {
  return /^[/\\]/.test(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Resolve `rel` under `cwd`; reject .., absolute paths, and paths outside cwd. */
function resolveSafeTeamAgentPath(cwd: string, rel: string): string | null {
  const t = rel.trim();
  if (!t || t.includes("..")) return null;
  if (isAbsolutePath(t)) return null;
  const abs = resolve(cwd, t);
  const root = resolve(cwd);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

function parseSequenceValue(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeTeamMember(
  item: unknown,
  sourceOrder: number,
): TeamMemberSpec | null {
  if (typeof item === "string") {
    const agent = item.trim();
    if (!agent) return null;
    return { agent, sourceOrder };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const agent =
    typeof o.agent === "string" ? o.agent.trim() : undefined;
  const path = typeof o.path === "string" ? o.path.trim() : undefined;
  const cardName =
    typeof o.name === "string" ? o.name.trim() : undefined;
  const color = typeof o.color === "string" ? o.color.trim() : undefined;
  const consultRaw = o["consult-when"] ?? o.consultWhen;
  const consultWhen =
    typeof consultRaw === "string" ? consultRaw.trim() : undefined;
  const sequence = parseSequenceValue(o.sequence);
  if (!path && !agent) return null;
  return {
    agent,
    path,
    cardName,
    color,
    consultWhen,
    sequence,
    sourceOrder,
  };
}

/** Parse a scalar from `key: value` (quoted strings, integers). */
function parseTeamsYamlScalar(raw: string): string | number {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/**
 * Dependency-free parser for team files: 2-space list items, 4-space object keys.
 * Matches this repo’s teams.yaml so the extension loads without `node_modules/yaml`
 * (e.g. when installed under ~/.pi/agent/extensions/).
 */
function parseTeamsYamlBuiltin(raw: string): Record<string, TeamMemberSpec[]> {
  const lines = raw.split(/\r?\n/);
  const teams: Record<string, TeamMemberSpec[]> = {};
  let currentTeam: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const hash = rawLine.indexOf("#");
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).replace(
      /\s+$/,
      "",
    );

    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0 && trimmed.endsWith(":") && !trimmed.startsWith("-")) {
      currentTeam = trimmed.slice(0, -1).trim();
      teams[currentTeam] = [];
      continue;
    }

    if (currentTeam === null) continue;

    if (indent === 2 && trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      const bucket = teams[currentTeam]!;

      if (!rest.includes(":")) {
        const spec = normalizeTeamMember(rest, bucket.length);
        if (spec) bucket.push(spec);
        continue;
      }

      const obj: Record<string, unknown> = {};
      const eq0 = rest.indexOf(":");
      const k0 = rest.slice(0, eq0).trim();
      const v0 = rest.slice(eq0 + 1).trim();
      obj[k0] = parseTeamsYamlScalar(v0);

      i++;
      while (i < lines.length) {
        const rl = lines[i]!;
        const h = rl.indexOf("#");
        const L = (h >= 0 ? rl.slice(0, h) : rl).replace(/\s+$/, "");
        if (!L.trim()) {
          i++;
          continue;
        }
        const d = L.length - L.trimStart().length;
        if (d < 4) {
          i--;
          break;
        }
        const t = L.trim();
        const eq = t.indexOf(":");
        if (eq === -1) {
          i++;
          continue;
        }
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim();
        obj[k] = parseTeamsYamlScalar(v);
        i++;
      }

      const spec = normalizeTeamMember(obj, bucket.length);
      if (spec) bucket.push(spec);
    }
  }

  return teams;
}

function parseTeamsFile(raw: string): Record<string, TeamMemberSpec[]> {
  return parseTeamsYamlBuiltin(raw);
}

function ansiTruecolorFg(hex: string): string | null {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}

const ANSI_RESET = "\x1b[0m";

// ── Frontmatter Parser ───────────────────────────

function parseSimpleYamlFrontmatter(
  raw: string,
): Record<string, string> | null {
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

function isSafeExtensionSlug(slug: string): boolean {
  const t = slug.trim();
  if (!t) return false;
  if (t.includes("..") || t.includes("/") || t.includes("\\")) return false;
  return true;
}

/** Comma-separated slugs from agent frontmatter `extensions:` */
function parseExtensionSlugs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const slug = part.trim();
    if (!isSafeExtensionSlug(slug)) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slug);
  }
  return out;
}

/** Build `-e` argv pairs for `extensions/<slug>/index.ts` under cwd; report missing slugs. */
function resolveSubagentExtensionArgs(
  cwd: string,
  slugs: string[],
): { argv: string[]; missing: string[] } {
  const argv: string[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const absPath = resolve(cwd, "extensions", slug, "index.ts");
    if (existsSync(absPath)) {
      argv.push("-e", absPath);
    } else {
      missing.push(slug);
    }
  }
  return { argv, missing };
}

function buildAgentSystemPrompt(
  def: Pick<AgentDef, "customSystemPrompt" | "systemPrompt">,
): string {
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
      extensionSlugs: parseExtensionSlugs(frontmatter.extensions),
      systemPrompt: match[2].trim(),
      customSystemPrompt: (frontmatter["system-prompt"] || "").trim(),
      systemPromptType: parseSystemPromptType(
        frontmatter["system-prompt-type"],
      ),
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
  /** One array of instances per agent type (key = def.name.toLowerCase()). */
  const agentStates: Map<string, AgentInstanceState[]> = new Map();
  let allAgentDefs: AgentDef[] = [];
  let teams: Record<string, TeamMemberSpec[]> = {};
  /** Project cwd from last loadAgents; used to resolve team member paths. */
  let teamCwd = "";
  let activeTeamName = "";
  let gridCols = 2;
  let widgetCtx: any;
  /** Set in loadAgents from ctx.sessionManager.getSessionId(); empty until first load. */
  let sessionDir = "";
  let contextWindow = 0;
  let isActive = true;
  let previousActiveTools: string[] | null = null;
  let teamsSource = "generated default team";
  /** After successful dispatch_agent, open /answer on parent session at agent_end (hasUI). */
  let pendingAnswerAfterDispatch = false;

  function loadAgents(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    sessionDir = join(ctx.cwd, ".pi", "agent-sessions", sessionId);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    allAgentDefs = scanAgentDirs(ctx.cwd);
    teamCwd = ctx.cwd;
    const teamsPath = findTeamsPath(ctx.cwd);
    teamsSource = formatTeamsSource(ctx.cwd, teamsPath);
    if (teamsPath) {
      try {
        teams = parseTeamsFile(readFileSync(teamsPath, "utf-8"));
      } catch {
        teams = {};
      }
    } else {
      teams = {};
    }
    if (Object.keys(teams).length === 0) {
      teams = {
        all: allAgentDefs.map((d, i) => ({
          agent: d.name,
          sourceOrder: i,
        })),
      };
    }
  }

  function totalInstanceCount(): number {
    let n = 0;
    for (const list of agentStates.values()) n += list.length;
    return n;
  }

  function recomputeGridCols() {
    const size = totalInstanceCount();
    gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
  }

  function defsByNameMap(): Map<string, AgentDef> {
    return new Map(allAgentDefs.map((d) => [d.name.toLowerCase(), d]));
  }

  function resolveSpecToLookupKey(spec: TeamMemberSpec): string | null {
    const defsByName = defsByNameMap();
    if (spec.path) {
      const abs = resolveSafeTeamAgentPath(teamCwd, spec.path);
      if (!abs) return null;
      const def = parseAgentFile(abs);
      return def ? agentLookupKey(def) : null;
    }
    if (spec.agent) {
      const def = defsByName.get(spec.agent.toLowerCase());
      return def ? agentLookupKey(def) : null;
    }
    return null;
  }

  /** One widget row per sequence value; trailing row for all unsequenced agents. */
  function partitionInstancesForWidget(
    ordered: AgentInstanceState[],
  ): AgentInstanceState[][] {
    if (ordered.length === 0) return [];
    const out: AgentInstanceState[][] = [];
    let i = 0;
    while (i < ordered.length) {
      const seq = ordered[i].teamSequence;
      const group: AgentInstanceState[] = [];
      if (seq !== undefined) {
        while (
          i < ordered.length &&
          ordered[i].teamSequence === seq
        ) {
          group.push(ordered[i]);
          i++;
        }
      } else {
        while (
          i < ordered.length &&
          ordered[i].teamSequence === undefined
        ) {
          group.push(ordered[i]);
          i++;
        }
      }
      out.push(group);
    }
    return out;
  }

  /** Canonical order for prompts, lists, and widget rows (sequence, then YAML order). */
  function flattenTeamInstances(): AgentInstanceState[] {
    const specs = teams[activeTeamName] || [];
    const collected: AgentInstanceState[] = [];
    for (const spec of specs) {
      const lk = resolveSpecToLookupKey(spec);
      if (!lk) continue;
      const list = agentStates.get(lk);
      if (!list?.length) continue;
      collected.push(
        ...[...list].sort((a, b) => a.instanceId - b.instanceId),
      );
    }
    return collected.sort((a, b) => {
      const sa = a.teamSequence ?? Number.POSITIVE_INFINITY;
      const sb = b.teamSequence ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa - sb;
      const oa = a.teamOrder ?? 0;
      const ob = b.teamOrder ?? 0;
      if (oa !== ob) return oa - ob;
      const ka = agentLookupKey(a.def).localeCompare(agentLookupKey(b.def));
      if (ka !== 0) return ka;
      return a.instanceId - b.instanceId;
    });
  }

  function availableAgentNamesForError(): string {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const list of agentStates.values()) {
      const def = list[0]?.def;
      if (!def) continue;
      const n = agentLookupKey(def);
      if (seen.has(n)) continue;
      seen.add(n);
      labels.push(displayName(def.name));
    }
    return labels.join(", ");
  }

  function formatInstanceLabel(state: AgentInstanceState): string {
    const base =
      state.teamCardName?.trim() || displayName(state.def.name);
    return `${base} #${state.instanceId}`;
  }

  function activateTeam(teamName: string) {
    activeTeamName = teamName;
    const members = teams[teamName] || [];
    const defsByName = defsByNameMap();
    agentStates.clear();
    const notify = (msg: string) => {
      if (widgetCtx?.hasUI && widgetCtx.ui?.notify) {
        widgetCtx.ui.notify(msg, "warning");
      }
    };
    for (const spec of members) {
      let def: AgentDef | null = null;
      if (spec.path) {
        const abs = resolveSafeTeamAgentPath(teamCwd, spec.path);
        if (!abs) {
          notify(`Team member: invalid or unsafe path "${spec.path}"`);
          continue;
        }
        if (!existsSync(abs)) {
          notify(`Team member: file not found "${spec.path}"`);
          continue;
        }
        def = parseAgentFile(abs);
        if (!def) {
          notify(`Team member: could not parse agent file "${spec.path}"`);
          continue;
        }
      } else if (spec.agent) {
        def = defsByName.get(spec.agent.toLowerCase()) ?? null;
        if (!def) {
          notify(
            `Team member: no agent "${spec.agent}" found in agents directories`,
          );
          continue;
        }
      } else {
        notify(
          `Team member: missing agent and path (index ${spec.sourceOrder})`,
        );
        continue;
      }
      const lk = agentLookupKey(def);
      const fk = agentFileKey(def);
      const sessionFile = initialSessionFileForInstance(sessionDir, fk, 1);
      agentStates.set(lk, [
        {
          instanceId: 1,
          def,
          status: "idle",
          task: "",
          toolCount: 0,
          elapsed: 0,
          lastWork: "",
          contextPct: 0,
          sessionFile,
          runCount: 0,
          teamCardName: spec.cardName,
          teamCardColor: spec.color,
          teamConsultWhen: spec.consultWhen,
          teamSequence: spec.sequence,
          teamOrder: spec.sourceOrder,
        },
      ]);
    }
    recomputeGridCols();
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
  function getStatusColor(status: AgentStatus): string {
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
  function getStatusIcon(status: AgentStatus): string {
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
  function getContextBar(state: AgentInstanceState): string {
    const filled = clamp(Math.ceil(state.contextPct / 20), 0, 5);
    const bar = "#".repeat(filled) + "-".repeat(5 - filled);
    return `[${bar}] ${Math.ceil(state.contextPct)}%`;
  }
  function getAgentDetailLines(
    state: AgentInstanceState,
    contentWidth: number,
  ): string[] {
    const description = truncateLine(
      state.def.description || "No description",
      contentWidth,
    );
    const task = truncateLine(state.task || "Waiting for work", contentWidth);
    const tools = truncateLine(`Tools: ${state.def.tools}`, contentWidth);
    const extSlugs = state.def.extensionSlugs;
    const extensions =
      extSlugs.length > 0
        ? truncateLine(`Extensions: ${extSlugs.join(", ")}`, contentWidth)
        : null;
    const runs = truncateLine(
      `Runs: ${state.runCount} · Session: ${state.sessionFile ? "resume" : "new"}`,
      contentWidth,
    );
    const detailLines = [
      `Role: ${description}`,
      `Task: ${task}`,
      tools,
      ...(extensions ? [extensions] : []),
      runs,
    ];
    return detailLines.flatMap((line) => wrapText(line, contentWidth, 2));
  }
  function renderCard(
    state: AgentInstanceState,
    colWidth: number,
    theme: any,
  ): string[] {
    const w = Math.max(8, colWidth - 2);
    const statusColor = getStatusColor(state.status);
    const statusIcon = getStatusIcon(state.status);
    const topBorderColor = "dim";
    const sideBorderColor = "dim";
    const customFg = state.teamCardColor
      ? ansiTruecolorFg(state.teamCardColor)
      : null;
    const top = "┌" + "─".repeat(w) + "┐";
    const bot = "└" + "─".repeat(w) + "┘";
    const border = (content: string, visibleLength: number) =>
      theme.fg(sideBorderColor, "│") +
      content +
      " ".repeat(Math.max(0, w - visibleLength)) +
      theme.fg(sideBorderColor, "│");
    const topLine =
      customFg != null
        ? customFg + top + ANSI_RESET
        : theme.fg(topBorderColor, top);
    const lines = [topLine];
    const modelSuffix = state.def.model ? ` [${state.def.model}]` : "";
    const headerLabel =
      state.teamCardName?.trim() || displayName(state.def.name);
    const nameText = truncateToWidth(
      `${headerLabel} #${state.instanceId}${modelSuffix}`,
      Math.max(1, w - 1),
    );
    const headerContent =
      customFg != null
        ? customFg + theme.bold(nameText) + ANSI_RESET
        : theme.fg("accent", theme.bold(nameText));
    lines.push(border(" " + headerContent, 1 + visibleWidth(headerContent)));
    const statusStr = `${statusIcon} ${state.status}${state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : ""}`;
    const statusText = truncateLine(statusStr, w - 1);
    lines.push(
      border(" " + theme.fg(statusColor, statusText), 1 + statusText.length),
    );
    const ctxStr = getContextBar(state);
    lines.push(border(" " + theme.fg("dim", ctxStr), 1 + ctxStr.length));
    const summaryLabel = state.status === "running" ? "Doing" : "Summary";
    const summaryRaw =
      state.status === "running"
        ? state.lastWork || state.task || "Working..."
        : state.task
          ? state.lastWork || state.task
          : state.def.description;
    const summaryLine = truncateLine(`${summaryLabel}: ${summaryRaw}`, w - 1);
    lines.push(
      border(" " + theme.fg("muted", summaryLine), 1 + summaryLine.length),
    );
    for (const detail of getAgentDetailLines(state, w - 1)) {
      lines.push(border(" " + theme.fg("muted", detail), 1 + detail.length));
    }
    if (state.def.customSystemPrompt) {
      const promptText = truncateLine("Custom system prompt ✓", w - 1);
      lines.push(
        border(" " + theme.fg("success", promptText), 1 + promptText.length),
      );
    }
    const botLine =
      customFg != null
        ? customFg + bot + ANSI_RESET
        : theme.fg(topBorderColor, bot);
    lines.push(botLine);
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
        ? `Team: ${activeTeamName} (${totalInstanceCount()} instances)`
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
          const ordered = flattenTeamInstances();
          const rowGroups = partitionInstancesForWidget(ordered);
          const gap = 1;
          const rows: string[][] = [];
          for (const rowAgents of rowGroups) {
            const cols = rowAgents.length;
            if (cols === 0) continue;
            const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
            const cards = rowAgents.map((agent) =>
              renderCard(agent, colWidth, theme),
            );
            const cardHeight = Math.max(...cards.map((card) => card.length));
            for (let line = 0; line < cardHeight; line++) {
              rows.push(cards.map((card) => card[line] || ""));
            }
          }
          const output = rows.map((columns) => columns.join(" ".repeat(gap)));
          text.setText(output.concat([""]).join("\n"));
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
    loadAgents(ctx);
    const teamNames = Object.keys(teams);
    if (teamNames.length > 0) {
      activateTeam(
        teams[activeTeamName]?.length ? activeTeamName : teamNames[0],
      );
    } else {
      activeTeamName = "";
      agentStates.clear();
    }
    pi.setActiveTools(["dispatch_agent", "execute_command"]);
    updateStatus(ctx);
    updateWidget();
    setFooter(ctx);
  }

  /** After main session switch/fork: new subagent directory without changing tool registration. */
  function refreshAgentTeamSession(ctx: ExtensionContext) {
    if (!isActive) return;
    widgetCtx = ctx;
    loadAgents(ctx);
    const teamNames = Object.keys(teams);
    if (teamNames.length > 0) {
      activateTeam(
        teams[activeTeamName]?.length ? activeTeamName : teamNames[0],
      );
    } else {
      activeTeamName = "";
      agentStates.clear();
    }
    updateStatus(ctx);
    updateWidget();
    setFooter(ctx);
  }

  function allocateDispatchSlot(
    agentName: string,
    requestedInstance: number | undefined,
  ):
    | { ok: true; state: AgentInstanceState }
    | { ok: false; message: string } {
    const key = agentName.toLowerCase();
    const instances = agentStates.get(key);
    if (!instances?.length) {
      return {
        ok: false,
        message: `Agent \"${agentName}\" not found. Available: ${availableAgentNamesForError()}`,
      };
    }
    const def = instances[0].def;
    const fk = agentFileKey(def);

    const ensureInstance = (instanceId: number): AgentInstanceState => {
      let s = instances.find((x) => x.instanceId === instanceId);
      if (s) return s;
      const t = instances[0];
      s = {
        instanceId,
        def,
        status: "idle",
        task: "",
        toolCount: 0,
        elapsed: 0,
        lastWork: "",
        contextPct: 0,
        sessionFile: initialSessionFileForInstance(sessionDir, fk, instanceId),
        runCount: 0,
        teamCardName: t.teamCardName,
        teamCardColor: t.teamCardColor,
        teamConsultWhen: t.teamConsultWhen,
        teamSequence: t.teamSequence,
        teamOrder: t.teamOrder,
      };
      instances.push(s);
      instances.sort((a, b) => a.instanceId - b.instanceId);
      recomputeGridCols();
      updateWidget();
      return s;
    };

    if (requestedInstance !== undefined) {
      if (
        !Number.isInteger(requestedInstance) ||
        requestedInstance < 1
      ) {
        return {
          ok: false,
          message: `Invalid instance for \"${agentName}\": use a positive integer (1, 2, …).`,
        };
      }
      const s = ensureInstance(requestedInstance);
      if (s.status === "running") {
        return {
          ok: false,
          message: `Agent \"${formatInstanceLabel(s)}\" is already running. Wait for it to finish.`,
        };
      }
      return { ok: true, state: s };
    }

    const idle = instances.find((s) => s.status !== "running");
    if (idle) return { ok: true, state: idle };

    const maxId = Math.max(...instances.map((i) => i.instanceId));
    return { ok: true, state: ensureInstance(maxId + 1) };
  }

  function dispatchAgent(
    agentName: string,
    task: string,
    ctx: any,
    requestedInstance?: number,
  ): Promise<{
    output: string;
    exitCode: number;
    elapsed: number;
    instanceId: number;
  }> {
    if (!isActive) {
      return Promise.resolve({
        output:
          "Agent team is deactivated. dispatch_agent is unavailable for this session.",
        exitCode: 1,
        elapsed: 0,
        instanceId: 0,
      });
    }
    const allocated = allocateDispatchSlot(agentName, requestedInstance);
    if (!allocated.ok) {
      return Promise.resolve({
        output: allocated.message,
        exitCode: 1,
        elapsed: 0,
        instanceId: 0,
      });
    }
    const state = allocated.state;
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
    const model =
      state.def.model ||
      (ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "openrouter/google/gemini-3-flash-preview");
    const fk = agentFileKey(state.def);
    const agentSessionFile = sessionPathForSpawn(state, sessionDir, fk);
    const agentSystemPrompt = buildAgentSystemPrompt(state.def);
    const { argv: extensionArgv, missing: missingExtensionSlugs } =
      resolveSubagentExtensionArgs(ctx.cwd, state.def.extensionSlugs);
    if (missingExtensionSlugs.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `${displayName(state.def.name)}: missing extension folder(s): ${missingExtensionSlugs.join(", ")} (expected extensions/<slug>/index.ts)`,
        "warning",
      );
    }
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
      ...extensionArgv,
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
          `${formatInstanceLabel(state)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
          state.status === "done" ? "success" : "error",
        );
        resolve({
          output: full,
          exitCode: code ?? 1,
          elapsed: state.elapsed,
          instanceId: state.instanceId,
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
          instanceId: state.instanceId,
        });
      });
    });
  }
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Dispatch a task to a specialist agent. The same agent type can run in parallel using separate instances (session files per instance). Omit instance to auto-pick a free slot or create a new one. Pass instance (1, 2, …) to pin work to a specific slot. See system prompt for agent names.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive)" }),
      task: Type.String({
        description: "Task description for the agent to execute",
      }),
      instance: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Optional instance number. Use for parallel runs or stable routing (e.g. 1 vs 2).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { agent, task, instance } = params as {
        agent: string;
        task: string;
        instance?: number;
      };
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
              instance,
              status: "error",
              elapsed: 0,
              exitCode: 1,
              fullOutput: "",
            },
          };
        }
        if (onUpdate) {
          const instHint =
            instance !== undefined ? ` #${instance}` : "";
          onUpdate({
            content: [
              { type: "text", text: `Dispatching to ${agent}${instHint}...` },
            ],
            details: {
              agent,
              task,
              instance,
              status: "dispatching",
            },
          });
        }
        const result = await dispatchAgent(agent, task, ctx, instance);
        if (result.exitCode === 0) {
          pendingAnswerAfterDispatch = true;
        }
        const truncated =
          result.output.length > 8000
            ? result.output.slice(0, 8000) + "\n\n... [truncated]"
            : result.output;
        const status = result.exitCode === 0 ? "done" : "error";
        const inst =
          result.instanceId > 0 ? ` #${result.instanceId}` : "";
        const summary = `[${agent}${inst}] ${status} in ${Math.round(result.elapsed / 1000)}s`;
        return {
          content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
          details: {
            agent,
            task,
            instance:
              result.instanceId > 0 ? result.instanceId : instance,
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
            instance,
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
      const inst = (args as any).instance;
      const instStr =
        inst !== undefined && inst !== null ? `#${inst} ` : "";
      const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
          theme.fg("accent", instStr + agentName) +
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
      if (options.isPartial || details.status === "dispatching") {
        const inst =
          details.instance !== undefined && details.instance !== null
            ? `#${details.instance} `
            : "";
        return new Text(
          theme.fg("accent", `● ${inst}${details.agent || "?"}`) +
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
      const inst =
        details.instance !== undefined && details.instance !== null
          ? `#${details.instance} `
          : "";
      const header =
        theme.fg(color, `${icon} ${inst}${details.agent}`) +
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
  pi.registerCommand("agents-team:select", {
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
        const memberSpecs = teams[name];
        const labels = memberSpecs.map((spec) => {
          if (spec.cardName?.trim()) return spec.cardName.trim();
          if (spec.agent) return displayName(spec.agent);
          return spec.path || "?";
        });
        return `${name} — ${labels.join(", ")}`;
      });
      const choice = await ctx.ui.select("Select Team", options);
      if (choice === undefined) return;
      const idx = options.indexOf(choice);
      const name = teamNames[idx];
      activateTeam(name);
      updateWidget();
      updateStatus(ctx);
      ctx.ui.notify(
        `Team: ${name} — ${flattenTeamInstances()
          .map((s) => formatInstanceLabel(s))
          .join(", ")}`,
        "info",
      );
    },
  });
  pi.registerCommand("agents-team:list", {
    description: "List all loaded agents",
    handler: async (_args, _ctx) => {
      widgetCtx = _ctx;
      if (!isActive) {
        return "Agent team is deactivated for this session.";
      }
      const names = flattenTeamInstances()
        .map((s) => {
          const session = s.sessionFile ? "resumed" : "new";
          return `${formatInstanceLabel(s)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
        })
        .join("\n");
      _ctx.ui.notify(names || "No agents loaded", "info");
    },
  });
  pi.registerCommand("agents-team:grid", {
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
        _ctx.ui.notify(
          `Grid preference set to ${gridCols} (team widget uses one row per sequence value)`,
          "info",
        );
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
      pendingAnswerAfterDispatch = false;
      for (const list of agentStates.values()) {
        for (const state of list) {
          if (state.timer) {
            clearInterval(state.timer);
            state.timer = undefined;
          }
          state.status = "disabled";
        }
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
      const members = flattenTeamInstances()
        .map((s) => formatInstanceLabel(s))
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
  pi.on("agent_end", async (_event, ctx) => {
    if (!pendingAnswerAfterDispatch) return;
    pendingAnswerAfterDispatch = false;
    if (!isActive || !ctx.hasUI) return;
    setTimeout(() => {
      pi.events.emit("trigger:answer", ctx);
    }, 100);
  });
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!isActive) return;
    const ordered = flattenTeamInstances();
    const seenCat = new Set<string>();
    const catalogPieces: string[] = [];
    for (const s of ordered) {
      const k = agentLookupKey(s.def);
      if (seenCat.has(k)) continue;
      seenCat.add(k);
      const title =
        s.teamCardName?.trim() || displayName(s.def.name);
      const ext =
        s.def.extensionSlugs.length > 0
          ? `\n**Extensions:** ${s.def.extensionSlugs.join(", ")}`
          : "";
      const consult = s.teamConsultWhen
        ? `\n**Consult when:** ${s.teamConsultWhen}`
        : "";
      catalogPieces.push(
        `### ${title}\n**Dispatch as:** \`${s.def.name}\` (optional \`instance\`: 1, 2, … for parallel slots)\n${s.def.description}\n**Tools:** ${s.def.tools}${ext}${consult}`,
      );
    }
    const agentCatalog = catalogPieces.join("\n\n");

    const specs = teams[activeTeamName] || [];
    const memberLabels: string[] = [];
    const seenMem = new Set<string>();
    for (const spec of specs) {
      const lk = resolveSpecToLookupKey(spec);
      if (!lk || !agentStates.has(lk)) continue;
      if (seenMem.has(lk)) continue;
      seenMem.add(lk);
      const def = agentStates.get(lk)![0].def;
      memberLabels.push(
        spec.cardName?.trim() || displayName(def.name),
      );
    }
    const teamMembers = memberLabels.join(", ");

    const numericSeqs = specs
      .map((sp) => sp.sequence)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    let firstDelegateLine = "";
    if (numericSeqs.length > 0) {
      const minS = Math.min(...numericSeqs);
      const preferredNames: string[] = [];
      const seenP = new Set<string>();
      for (const spec of specs) {
        if (spec.sequence !== minS) continue;
        const lk = resolveSpecToLookupKey(spec);
        if (!lk || seenP.has(lk)) continue;
        seenP.add(lk);
        const def = agentStates.get(lk)?.[0]?.def;
        if (def) preferredNames.push(`\`${def.name}\``);
      }
      if (preferredNames.length > 0) {
        firstDelegateLine = `
When starting work on a **new** user goal, prefer an initial dispatch to: ${preferredNames.join(", ")} (lowest \`sequence\` on this team), unless another specialist is clearly more appropriate.
`;
      }
    }

    return {
      systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.
${firstDelegateLine}
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
- The same specialist can run in parallel: each instance uses its own session file (\`{name}-1.jsonl\`, \`{name}-2.jsonl\`, …). Omit \`instance\` to auto-pick a free slot or create a new one; pass \`instance: 1\` / \`instance: 2\` when you need a stable mapping (e.g. two parallel tasks)
- After a successful specialist dispatch, the session may open /answer automatically so the user can respond to questions in the last reply
- When you ask multiple questions in one message (without dispatching), use execute_command with command \`/answer\` so the user gets the Q&A UI
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
    };
  });
  pi.on("session_start", async (_event, _ctx) => {
    if (widgetCtx) {
      widgetCtx.ui.setWidget("agent-team", undefined);
    }
    widgetCtx = _ctx;
    contextWindow = _ctx.model?.contextWindow || 0;
    isActive = true;
    previousActiveTools = pi.getActiveTools();
    enableAgentTeam(_ctx);
    _ctx.ui.notify(`Team sets loaded from: ${teamsSource}`, "info");
    updateWidget();
  });

  pi.on("session_switch", async (_event, ctx) => {
    refreshAgentTeamSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    refreshAgentTeamSession(ctx);
  });
}
