import { pool } from "../config/db.js";
import {
  getAIProvider,
  type ChatMessage,
  type ToolCall,
  type ToolDef,
} from "../ai/index.js";
import { retrieveAssignedTasks, scheduleTaskEmbedding } from "./task-embeddings.js";
import {
  normalizePhoneDigits,
  phonesMatchLocal,
  toLocalPhoneDigits,
  sendWhatsAppToChatId,
} from "./whatsapp.js";
import {
  getTaskByNumber,
  saveTaskList,
  type TaskListItem,
} from "./whatsapp-task-session.js";

const MAX_TOOL_ROUNDS = 4;

const TASK_BOT_TOOLS: ToolDef[] = [
  {
    name: "list_my_tasks",
    description: "List tasks assigned to the current user. Optionally filter by status.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional status filter",
          enum: ["pending", "in_progress", "completed", "overdue"],
        },
      },
    },
  },
  {
    name: "get_task_details",
    description: "Get full details and recent comments for a task assigned to the user.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_task_status",
    description: "Update the status of a task assigned to the user.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        status: {
          type: "string",
          description: "New status",
          enum: ["pending", "in_progress", "completed"],
        },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "add_task_update",
    description: "Add a progress update/comment on a task assigned to the user.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        content: { type: "string", description: "Update text" },
      },
      required: ["task_id", "content"],
    },
  },
];

type ProfileRow = {
  id: string;
  full_name: string | null;
  phone: string;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
};

type ShortCommand =
  | { kind: "status"; n: number; status: "pending" | "in_progress" | "completed" }
  | { kind: "update"; n: number; content: string }
  | { kind: "details"; n: number };

export async function findProfileByPhoneDigits(phoneDigits: string): Promise<ProfileRow | null> {
  // WhatsApp may send 91…; profiles store local number without country code.
  const localDigits = toLocalPhoneDigits(phoneDigits);
  if (!localDigits) {
    console.warn("[WhatsAppBot] resolve profile skipped — empty phone digits");
    return null;
  }

  const result = await pool.query(
    `SELECT id, full_name, phone FROM profiles
     WHERE phone IS NOT NULL AND trim(phone) <> ''`
  );

  const candidates = (result.rows as ProfileRow[]).map((row) => {
    const profileLocal = toLocalPhoneDigits(row.phone);
    const wouldMatch = phonesMatchLocal(localDigits, row.phone);
    return {
      id: row.id,
      fullName: row.full_name,
      phoneRaw: row.phone,
      phoneDigits: profileLocal || null,
      matchExact: profileLocal === localDigits,
      wouldMatch,
    };
  });

  const matched = candidates.find((c) => c.wouldMatch) ?? null;

  console.log("[WhatsAppBot] resolve profile (local digits vs profiles.phone)", {
    matchPhoneDigits: localDigits,
    matchDigitLength: localDigits.length,
    inboundRawDigits: normalizePhoneDigits(phoneDigits),
    candidateCount: candidates.length,
    candidates,
    matchedProfileId: matched?.id ?? null,
    matchedPhoneRaw: matched?.phoneRaw ?? null,
  });

  if (!matched) return null;
  return (result.rows as ProfileRow[]).find((r) => r.id === matched.id) ?? null;
}

async function assertAssigned(taskId: string, profileId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM task_assignees WHERE task_id = $1 AND profile_id = $2`,
    [taskId, profileId]
  );
  return result.rows.length > 0;
}

function formatTaskListMessage(items: TaskListItem[], rows: TaskRow[]): string {
  if (items.length === 0) {
    return "You have no assigned tasks right now.";
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = items.map((item) => {
    const row = byId.get(item.taskId);
    const status = row?.status?.replace(/_/g, " ") ?? "unknown";
    const priority = row?.priority ?? "medium";
    const due = row?.due_date
      ? new Date(row.due_date).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "no due date";
    return `${item.n}. ${item.title}\n   Status: ${status} · Priority: ${priority} · Due: ${due}`;
  });

  return [
    `You have ${items.length} assigned task${items.length === 1 ? "" : "s"}:`,
    "",
    ...lines,
    "",
    "Quick actions (use the number from the list):",
    '• Mark complete: "1 done"',
    '• Change status: "1 in progress" or "1 pending"',
    '• Add a note: "2: waiting on client"',
    '• View details: "3" or "details 3"',
  ].join("\n");
}

function formatDetailsMessage(toolJson: string): string {
  try {
    const parsed = JSON.parse(toolJson) as {
      error?: string;
      task?: {
        title?: string;
        description?: string | null;
        status?: string;
        priority?: string;
        due_date?: string | null;
        project_name?: string | null;
      } | null;
      recent_updates?: Array<{
        content?: string;
        author_name?: string | null;
        created_at?: string;
      }>;
    };
    if (parsed.error) return parsed.error;
    const task = parsed.task;
    if (!task) return "Task not found.";

    const lines = [
      `*${task.title ?? "Task"}*`,
      `Status: ${task.status ?? "—"} · Priority: ${task.priority ?? "—"}`,
    ];
    if (task.due_date) lines.push(`Due: ${task.due_date}`);
    if (task.project_name) lines.push(`Project: ${task.project_name}`);
    if (task.description) lines.push("", task.description);

    const updates = parsed.recent_updates ?? [];
    if (updates.length > 0) {
      lines.push("", "Recent updates:");
      for (const u of updates.slice(0, 3)) {
        const who = u.author_name ?? "Someone";
        lines.push(`• ${who}: ${u.content ?? ""}`);
      }
    }
    return lines.join("\n");
  } catch {
    return "Could not load task details.";
  }
}

function parseShortCommand(text: string): ShortCommand | null {
  const t = text.trim();

  let m = t.match(/^details?\s+(\d+)\s*$/i);
  if (m) return { kind: "details", n: Number(m[1]) };

  m = t.match(/^(\d+)\s+(done|completed|in\s+progress|pending)\s*$/i);
  if (m) {
    const raw = m[2].toLowerCase().replace(/\s+/g, " ");
    let status: "pending" | "in_progress" | "completed";
    if (raw === "done" || raw === "completed") status = "completed";
    else if (raw === "in progress") status = "in_progress";
    else status = "pending";
    return { kind: "status", n: Number(m[1]), status };
  }

  m = t.match(/^(\d+)\s*[:\-]\s*(.+)$/s);
  if (m && m[2].trim()) {
    return { kind: "update", n: Number(m[1]), content: m[2].trim() };
  }

  m = t.match(/^(\d+)\s*$/);
  if (m) return { kind: "details", n: Number(m[1]) };

  return null;
}

async function handleShortCommand(params: {
  command: ShortCommand;
  phoneLocal: string;
  profileId: string;
  replyChatId: string;
}): Promise<void> {
  const { command, phoneLocal, profileId, replyChatId } = params;
  const item = getTaskByNumber(phoneLocal, command.n);

  if (!item) {
    await sendWhatsAppToChatId(
      replyChatId,
      "No recent numbered list, or that number isn’t valid. Send “list my tasks” first."
    );
    return;
  }

  if (command.kind === "status") {
    const toolResult = await executeTool(
      {
        id: "short-status",
        name: "update_task_status",
        arguments: { task_id: item.taskId, status: command.status },
      },
      profileId,
      phoneLocal
    );
    try {
      const parsed = JSON.parse(toolResult) as {
        error?: string;
        ok?: boolean;
        task?: { title?: string; status?: string };
      };
      if (parsed.error) {
        await sendWhatsAppToChatId(replyChatId, parsed.error);
        return;
      }
      await sendWhatsAppToChatId(
        replyChatId,
        `Marked “${parsed.task?.title ?? item.title}” as ${parsed.task?.status ?? command.status}.`
      );
    } catch {
      await sendWhatsAppToChatId(replyChatId, "Could not update task status.");
    }
    return;
  }

  if (command.kind === "update") {
    const toolResult = await executeTool(
      {
        id: "short-update",
        name: "add_task_update",
        arguments: { task_id: item.taskId, content: command.content },
      },
      profileId,
      phoneLocal
    );
    try {
      const parsed = JSON.parse(toolResult) as { error?: string; ok?: boolean };
      if (parsed.error) {
        await sendWhatsAppToChatId(replyChatId, parsed.error);
        return;
      }
      await sendWhatsAppToChatId(
        replyChatId,
        `Added update on “${item.title}”: ${command.content}`
      );
    } catch {
      await sendWhatsAppToChatId(replyChatId, "Could not add task update.");
    }
    return;
  }

  const toolResult = await executeTool(
    {
      id: "short-details",
      name: "get_task_details",
      arguments: { task_id: item.taskId },
    },
    profileId,
    phoneLocal
  );
  await sendWhatsAppToChatId(replyChatId, formatDetailsMessage(toolResult));
}

async function executeTool(
  call: ToolCall,
  profileId: string,
  phoneLocal: string | null
): Promise<string> {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "list_my_tasks": {
      const status = typeof args.status === "string" ? args.status : null;
      const params: unknown[] = [profileId];
      let sql = `
        SELECT t.id, t.title, t.status, t.priority, t.due_date
        FROM tasks t
        JOIN task_assignees ta ON ta.task_id = t.id AND ta.profile_id = $1
      `;
      if (status) {
        params.push(status);
        sql += ` WHERE t.status = $2`;
      }
      sql += ` ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 20`;
      const result = await pool.query(sql, params);
      const rows = result.rows as TaskRow[];

      let numbered: TaskListItem[] = [];
      if (phoneLocal) {
        numbered = saveTaskList(
          phoneLocal,
          rows.map((r) => ({ taskId: r.id, title: r.title }))
        );
      } else {
        numbered = rows.map((r, i) => ({
          n: i + 1,
          taskId: r.id,
          title: r.title,
        }));
      }

      return JSON.stringify({
        tasks: rows.map((r, i) => ({
          n: numbered[i]?.n ?? i + 1,
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          due_date: r.due_date,
        })),
        formatted: formatTaskListMessage(numbered, rows),
      });
    }

    case "get_task_details": {
      const taskId = String(args.task_id ?? "");
      if (!taskId) return JSON.stringify({ error: "task_id required" });
      if (!(await assertAssigned(taskId, profileId))) {
        return JSON.stringify({ error: "Task not found or not assigned to you" });
      }
      const taskResult = await pool.query(
        `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.completed_at,
                p.name as project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.id = $1`,
        [taskId]
      );
      const commentsResult = await pool.query(
        `SELECT c.content, c.created_at, pr.full_name as author_name
         FROM task_comments c
         LEFT JOIN profiles pr ON pr.id = c.user_id
         WHERE c.task_id = $1
         ORDER BY c.created_at DESC
         LIMIT 5`,
        [taskId]
      );
      return JSON.stringify({
        task: taskResult.rows[0] ?? null,
        recent_updates: commentsResult.rows,
      });
    }

    case "update_task_status": {
      const taskId = String(args.task_id ?? "");
      const status = String(args.status ?? "");
      if (!taskId || !status) return JSON.stringify({ error: "task_id and status required" });
      if (!["pending", "in_progress", "completed"].includes(status)) {
        return JSON.stringify({ error: "Invalid status" });
      }
      if (!(await assertAssigned(taskId, profileId))) {
        return JSON.stringify({ error: "Task not found or not assigned to you" });
      }
      const completedAt = status === "completed" ? new Date().toISOString() : null;
      const result = await pool.query(
        `UPDATE tasks SET status = $1, completed_at = $2 WHERE id = $3
         RETURNING id, title, status, priority, due_date, completed_at`,
        [status, completedAt, taskId]
      );
      scheduleTaskEmbedding(taskId);
      return JSON.stringify({ ok: true, task: result.rows[0] });
    }

    case "add_task_update": {
      const taskId = String(args.task_id ?? "");
      const content = String(args.content ?? "").trim();
      if (!taskId || !content) return JSON.stringify({ error: "task_id and content required" });
      if (!(await assertAssigned(taskId, profileId))) {
        return JSON.stringify({ error: "Task not found or not assigned to you" });
      }
      const result = await pool.query(
        `INSERT INTO task_comments (task_id, user_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, content, created_at`,
        [taskId, profileId, content]
      );
      scheduleTaskEmbedding(taskId);
      return JSON.stringify({ ok: true, update: result.rows[0] });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${call.name}` });
  }
}

function buildSystemPrompt(userName: string, ragContext: string): string {
  return [
    "You are the Office CRM WhatsApp assistant for task management.",
    `The current user is ${userName}. They can only see and update tasks assigned to them.`,
    "Help them identify assigned tasks, share details, update status, and add progress updates.",
    "Use tools when you need live data or to make changes. Prefer short WhatsApp-friendly replies.",
    "When referring to a task after a tool call, include its title; include the UUID only when needed for clarity.",
    "Users may also use short forms from a recent numbered list (e.g. “1 done”, “2: note”); those are handled separately when possible.",
    "Relevant assigned tasks from semantic search (may be incomplete — use list_my_tasks if needed):",
    ragContext || "(none retrieved)",
  ].join("\n");
}

export async function handleIncomingWhatsAppMessage(params: {
  chatId: string;
  body: string;
  matchPhoneDigits: string | null;
  replyChatId: string;
  identitySource: string;
}): Promise<void> {
  const { chatId, body, matchPhoneDigits, replyChatId, identitySource } = params;
  const text = body.trim();
  if (!text) return;

  console.log("[WhatsAppBot] handleIncoming start", {
    chatId,
    matchPhoneDigits,
    replyChatId,
    identitySource,
    bodyPreview: text.slice(0, 80) + (text.length > 80 ? "…" : ""),
  });

  if (!matchPhoneDigits) {
    console.warn("[WhatsAppBot] no resolvable phone (LID without senderPhone) — cannot match profile", {
      chatId,
      replyChatId,
      identitySource,
    });
    await sendWhatsAppToChatId(
      replyChatId,
      "I couldn't resolve your WhatsApp phone number yet. Ask an admin to ensure OpenWA LID→phone is enabled, and that your Team profile phone matches your WhatsApp number (local digits only, e.g. 8921565767)."
    );
    return;
  }

  const profile = await findProfileByPhoneDigits(matchPhoneDigits);
  if (!profile) {
    console.warn("[WhatsAppBot] no profile match — sending unlink notice", {
      chatId,
      matchPhoneDigits,
      replyChatId,
      identitySource,
    });
    await sendWhatsAppToChatId(
      replyChatId,
      "Your WhatsApp number is not linked to an Office CRM profile. Ask an admin to set your phone on the Team page (local number without country code, e.g. 8921565767)."
    );
    return;
  }

  const phoneLocal = toLocalPhoneDigits(matchPhoneDigits) || toLocalPhoneDigits(profile.phone);

  console.log("[WhatsAppBot] profile matched", {
    profileId: profile.id,
    fullName: profile.full_name,
    profilePhoneRaw: profile.phone,
    profilePhoneLocal: toLocalPhoneDigits(profile.phone),
    matchPhoneDigits,
    phoneLocal,
    webhookChatId: chatId,
    replyChatId,
    identitySource,
  });

  const shortCommand = parseShortCommand(text);
  if (shortCommand && phoneLocal) {
    console.log("[WhatsAppBot] short command fast path", shortCommand);
    await handleShortCommand({
      command: shortCommand,
      phoneLocal,
      profileId: profile.id,
      replyChatId,
    });
    return;
  }

  let ragContext = "";
  try {
    const retrieved = await retrieveAssignedTasks(profile.id, text, 5);
    ragContext = retrieved
      .map(
        (t, i) =>
          `${i + 1}. [${t.task_id}] "${t.title}" (${t.status}/${t.priority}) — ${t.content.slice(0, 300)}`
      )
      .join("\n");
  } catch (error) {
    console.error("[WhatsAppBot] RAG retrieve failed (continuing with tools only):", error);
  }

  const ai = getAIProvider();
  const messages: ChatMessage[] = [
    { role: "user", content: text },
  ];

  const system = buildSystemPrompt(profile.full_name ?? "User", ragContext);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await ai.chat({
      messages,
      tools: TASK_BOT_TOOLS,
      system,
    });

    if (result.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: result.content ?? "",
        toolCalls: result.toolCalls,
        providerModelParts: result.providerModelParts,
      });

      const listOnly =
        result.toolCalls.length === 1 && result.toolCalls[0]?.name === "list_my_tasks";
      let listFormatted: string | null = null;

      for (const call of result.toolCalls) {
        const toolResult = await executeTool(call, profile.id, phoneLocal);
        messages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: toolResult,
        });

        if (call.name === "list_my_tasks") {
          try {
            const parsed = JSON.parse(toolResult) as { formatted?: string };
            if (typeof parsed.formatted === "string") {
              listFormatted = parsed.formatted;
            }
          } catch {
            // ignore parse errors; LLM path continues
          }
        }
      }

      // Deterministic list reply so numbers always match the saved session map.
      if (listOnly && listFormatted) {
        await sendWhatsAppToChatId(replyChatId, listFormatted);
        return;
      }

      continue;
    }

    const reply =
      result.content?.trim() ||
      "I could not generate a reply. Try asking about your tasks again.";
    await sendWhatsAppToChatId(replyChatId, reply);
    return;
  }

  await sendWhatsAppToChatId(
    replyChatId,
    "I took several steps but could not finish. Please try a shorter request, e.g. “list my tasks” or “mark X as completed”."
  );
}
