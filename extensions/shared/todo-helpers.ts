// Shared helpers for todo file/directory logic. Used by both agent-team and todos extensions.

import path from "path";
import os from "os";
import { existsSync, readdirSync, readFileSync } from "fs";

// --- Directory resolution ---
export function getTodosDir(cwd: string): string {
  const overridePath = process.env["PI_TODO_PATH"];
  if (overridePath && overridePath.trim()) {
    return path.resolve(cwd, overridePath.trim());
  }
  return path.join(os.homedir(), ".pi", "history", path.basename(cwd), "todos");
}

// --- Frontmatter/format parsing ---
export function findJsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = false; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { depth++; continue; }
    if (char === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  if (!content.startsWith("{")) {
    return { frontMatter: "", body: content };
  }
  const endIndex = findJsonObjectEnd(content);
  if (endIndex === -1) {
    return { frontMatter: "", body: content };
  }
  const frontMatter = content.slice(0, endIndex + 1);
  const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
  return { frontMatter, body };
}

export type TodoStatus = "completed" | "in-progress" | "not-started";

export function parseFrontMatter(text: string, idFallback: string): any {
  const data: any = { id: idFallback, title: "", tags: [], status: "open", created_at: "", assigned_to_session: undefined };
  const trimmed = text.trim();
  if (!trimmed) return data;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return data;
    if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
    if (typeof parsed.title === "string") data.title = parsed.title;
    if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
    if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
    if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
      data.assigned_to_session = parsed.assigned_to_session;
    }
    if (Array.isArray(parsed.tags)) {
      data.tags = parsed.tags.filter((tag) => typeof tag === "string");
    }
  } catch { return data; }
  return data;
}

// --- File reading ---
export function parseTodoFile(filePath: string): any {
  try {
    const content = readFileSync(filePath, "utf8");
    const { frontMatter } = splitFrontMatter(content);
    return parseFrontMatter(frontMatter, path.basename(filePath, ".md"));
  } catch { return null; }
}

// --- Status normalization ---
export function normalizeTodoStatus(raw: string): TodoStatus {
  const s = (raw||"").toLowerCase();
  if (["completed", "done", "closed"].includes(s)) return "completed";
  if (["in-progress", "inprogress", "progress", "active"].includes(s)) return "in-progress";
  return "not-started";
}

// --- Listing + Filtering ---
export function listTodosSync(todosDir: string): any[] {
  let files: string[] = [];
  try { files = readdirSync(todosDir).filter(f => f.endsWith('.md')); } catch {}
  return files.map(f => parseTodoFile(path.join(todosDir, f))).filter(Boolean);
}

export function agentSessionName(name: string): string {
  return `${name.toLowerCase().replace(/\s+/g, "-")}.json`;
}

export function findAgentTodos(todosDir: string, agentSession: string) {
  // All project todos, robust frontmatter parse
  const todos: any[] = listTodosSync(todosDir);
  // First try: ALL assigned (any status) to this agent/session
  const assigned = todos.filter(t => t.assigned_to_session === agentSession);
  if (assigned.length > 0) return assigned;
  // Fallback: all open and *unassigned* todos (not closed)
  return todos.filter(t => !t.assigned_to_session && !["closed", "done", "completed"].includes((t.status||"").toLowerCase()));
}

export function todoStats(todos: any[]): { completed: number, total: number } {
  const total = todos.length;
  const completed = todos.filter(t => normalizeTodoStatus(t.status) === "completed").length;
  return { completed, total };
}

export function contextualTodos(todos: any[]): any[] {
  // Show: most recent completed (assigned or fallback), oldest in-progress, oldest not-started
  const completed = todos
    .filter(t => normalizeTodoStatus(t.status) === "completed")
    .sort((a, b) => (b.created_at||"").localeCompare(a.created_at||""));
  const inProgress = todos
    .filter(t => normalizeTodoStatus(t.status) === "in-progress")
    .sort((a, b) => (a.created_at||"").localeCompare(b.created_at||""));
  const notStarted = todos
    .filter(t => normalizeTodoStatus(t.status) === "not-started")
    .sort((a, b) => (a.created_at||"").localeCompare(b.created_at||""));
  const entries = [];
  if (completed.length > 0) entries.push(completed[0]);
  if (inProgress.length > 0) entries.push(inProgress[0]);
  if (notStarted.length > 0) entries.push(notStarted[0]);
  return entries;
}

export const TODO_STATUS_ICON: Record<TodoStatus, string> = {
  completed: "✓",
  "in-progress": "◉",
  "not-started": "○"
};
