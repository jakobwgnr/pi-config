/**
 * Core types for manage_todo_list (Copilot-compatible schema).
 * Vendored from pi-manage-todo-list for local loading via agent-team dispatch.
 */

export type TodoStatus = "not-started" | "in-progress" | "completed";

export interface TodoItem {
  id: number;
  title: string;
  description: string;
  status: TodoStatus;
}

export interface TodoDetails {
  operation: "read" | "write";
  todos: TodoItem[];
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface TodoStats {
  total: number;
  completed: number;
  inProgress: number;
  notStarted: number;
}
