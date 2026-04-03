/**
 * Todo state + session reconstruction (pi-manage-todo-list).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TodoItem, TodoDetails, ValidationResult, TodoStats } from "./types";

function isValidTodoStatus(s: unknown): s is TodoItem["status"] {
  return (
    s === "not-started" || s === "in-progress" || s === "completed"
  );
}

function isValidTodoItem(x: unknown): x is TodoItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "number" &&
    typeof o.title === "string" &&
    typeof o.description === "string" &&
    isValidTodoStatus(o.status)
  );
}

/** Last manage_todo_list snapshot in a session JSONL line stream (same as agent-team). */
function parseLatestTodosFromSessionJsonl(raw: string): TodoItem[] | null {
  let last: TodoItem[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r.type !== "message" || !r.message || typeof r.message !== "object")
      continue;
    const msg = r.message as Record<string, unknown>;
    if (msg.role !== "toolResult" || msg.toolName !== "manage_todo_list")
      continue;
    const details = msg.details;
    if (!details || typeof details !== "object") continue;
    const todos = (details as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) continue;
    const cleaned = todos.filter(isValidTodoItem);
    last = cleaned;
  }
  return last;
}

/** Subagent sessions (agent-team): latest todos from the most recently modified *.jsonl for this main session. */
function loadLatestTodosFromAgentSessions(ctx: ExtensionContext): TodoItem[] {
  const sessionId = ctx.sessionManager.getSessionId();
  const dir = join(ctx.cwd, ".pi", "agent-sessions", sessionId);
  if (!existsSync(dir)) return [];

  let best: TodoItem[] = [];
  let bestMtime = 0;

  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const abs = join(dir, ent.name);
    let raw: string;
    let st;
    try {
      st = statSync(abs);
      raw = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseLatestTodosFromSessionJsonl(raw);
    if (parsed == null || parsed.length === 0) continue;
    const m = st.mtimeMs;
    if (m >= bestMtime) {
      bestMtime = m;
      best = parsed.map((t) => ({ ...t }));
    }
  }

  return best;
}

export class TodoStateManager {
  private todos: TodoItem[] = [];

  read(): TodoItem[] {
    return [...this.todos];
  }

  write(todos: TodoItem[]): void {
    this.todos = todos.map((t) => ({ ...t }));
  }

  clear(): void {
    this.todos = [];
  }

  getStats(): TodoStats {
    const total = this.todos.length;
    const completed = this.todos.filter((t) => t.status === "completed").length;
    const inProgress = this.todos.filter((t) => t.status === "in-progress").length;
    const notStarted = this.todos.filter((t) => t.status === "not-started").length;
    return { total, completed, inProgress, notStarted };
  }

  validate(todos: TodoItem[]): ValidationResult {
    const errors: string[] = [];

    if (!Array.isArray(todos)) {
      return { valid: false, errors: ["todoList must be an array"] };
    }

    const validStatuses = new Set(["not-started", "in-progress", "completed"]);

    for (let i = 0; i < todos.length; i++) {
      const item = todos[i]!;
      const prefix = `Item ${i + 1}`;

      if (item.id == null) {
        errors.push(`${prefix}: missing 'id'`);
      } else if (typeof item.id !== "number") {
        errors.push(`${prefix}: 'id' must be a number`);
      }

      if (!item.title || typeof item.title !== "string") {
        errors.push(`${prefix}: missing or invalid 'title'`);
      }

      if (!item.description || typeof item.description !== "string") {
        errors.push(`${prefix}: missing or invalid 'description'`);
      }

      if (!item.status || !validStatuses.has(item.status)) {
        errors.push(
          `${prefix}: 'status' must be one of: not-started, in-progress, completed`,
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  loadFromSession(ctx: ExtensionContext): void {
    this.todos = [];
    let sawManageTodoTool = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "manage_todo_list")
        continue;

      sawManageTodoTool = true;
      const details = msg.details as TodoDetails | undefined;
      if (details?.todos && Array.isArray(details.todos)) {
        this.todos = details.todos.map((t) => ({ ...t }));
      }
    }

    if (!sawManageTodoTool && this.todos.length === 0) {
      const fromAgents = loadLatestTodosFromAgentSessions(ctx);
      if (fromAgents.length > 0) {
        this.todos = fromAgents;
      }
    }
  }
}
