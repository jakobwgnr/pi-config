/**
 * Read-only todo widget above editor (pi-manage-todo-list).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TodoStatus } from "../types";
import type { TodoStateManager } from "../state-manager";

const WIDGET_ID = "todo-list";

export const STATUS_ICONS: Record<TodoStatus, string> = {
  completed: "✓",
  "in-progress": "◉ ",
  "not-started": "○",
};

export function updateWidget(
  state: TodoStateManager,
  ctx: ExtensionContext,
  options?: { agentTeamActive?: boolean },
): void {
  const todos = state.read();

  if (todos.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const stats = state.getStats();
  const hideHeaderProgress = options?.agentTeamActive === true;

  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    const lines: string[] = [];

    const header = hideHeaderProgress
      ? theme.fg("accent", " Todo List ")
      : theme.fg("accent", " Todo List ") +
        theme.fg("muted", `— ${stats.completed}/${stats.total} completed`);
    lines.push(header);

    for (const todo of todos) {
      const icon = STATUS_ICONS[todo.status] ?? "⏳";
      const id = theme.fg("accent", `${todo.id}.`);

      let title: string;
      if (todo.status === "completed") {
        title = theme.fg("dim", theme.strikethrough(todo.title));
      } else if (todo.status === "in-progress") {
        title = theme.fg("warning", todo.title);
      } else {
        title = todo.title;
      }

      lines.push(` ${icon} ${id} ${title}`);
    }

    return {
      render: () => lines,
      invalidate: () => {},
    };
  });
}

export function clearWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_ID, undefined);
}
