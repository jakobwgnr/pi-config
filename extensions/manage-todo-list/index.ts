/**
 * Local copy of pi-manage-todo-list — registers manage_todo_list for dispatched agents.
 *
 * Loaded via agent frontmatter: extensions: ..., manage-todo-list
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TodoStateManager } from "./state-manager";
import { createManageTodoListTool } from "./tool";
import { updateWidget, clearWidget } from "./ui/todo-widget";

export default function (pi: ExtensionAPI) {
  const state = new TodoStateManager();

  let currentCtx: ExtensionContext | undefined;

  const onTodoUpdate = () => {
    if (currentCtx) {
      updateWidget(state, currentCtx);
    }
  };

  const reconstructState = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);
    updateWidget(state, ctx);
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.on("turn_start", async (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    updateWidget(state, ctx);
  });

  const tool = createManageTodoListTool(state, onTodoUpdate);
  pi.registerTool(tool);

  pi.registerCommand("todos", {
    description: "Toggle todo list widget or clear todos (/todos clear)",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (args?.trim().toLowerCase() === "clear") {
        state.clear();
        clearWidget(ctx);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }

      const todos = state.read();
      if (todos.length === 0) {
        ctx.ui.notify(
          "No todos. The LLM will create them when working on complex tasks.",
          "info",
        );
      } else {
        updateWidget(state, ctx);
        ctx.ui.notify(
          `${state.getStats().completed}/${state.getStats().total} todos completed.`,
          "info",
        );
      }
    },
  });
}
