/**
 * Local copy of pi-manage-todo-list — registers manage_todo_list for dispatched agents.
 *
 * Loaded via agent frontmatter: extensions: ..., manage-todo-list
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TodoStateManager } from "./state-manager";
import { createManageTodoListTool } from "./tool";
import { updateWidget, clearWidget } from "./ui/todo-widget";

const AGENT_TEAM_ACTIVE_CHANNEL = "agent-team:active";

export default function (pi: ExtensionAPI) {
  const state = new TodoStateManager();

  let currentCtx: ExtensionContext | undefined;
  let agentTeamActive = false;

  pi.events.on(AGENT_TEAM_ACTIVE_CHANNEL, (data: unknown) => {
    const o = data as { active?: boolean };
    agentTeamActive = o?.active === true;
    if (currentCtx) {
      state.loadFromSession(currentCtx);
      updateWidget(state, currentCtx, { agentTeamActive });
    }
  });

  const onTodoUpdate = () => {
    if (currentCtx) {
      updateWidget(state, currentCtx, { agentTeamActive });
    }
  };

  const reconstructState = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);
    updateWidget(state, ctx, { agentTeamActive });
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
    state.loadFromSession(ctx);
    updateWidget(state, ctx, { agentTeamActive });
  });

  const tool = createManageTodoListTool(state, onTodoUpdate, {
    isAgentTeamActive: () => agentTeamActive,
  });
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

      state.loadFromSession(ctx);
      const todos = state.read();
      if (todos.length === 0) {
        ctx.ui.notify(
          "No todos. The LLM will create them when working on complex tasks.",
          "info",
        );
      } else {
        updateWidget(state, ctx, { agentTeamActive });
        ctx.ui.notify(
          agentTeamActive
            ? "Todo list shown (progress is on the team dashboard)."
            : `${state.getStats().completed}/${state.getStats().total} todos completed.`,
          "info",
        );
      }
    },
  });
}
