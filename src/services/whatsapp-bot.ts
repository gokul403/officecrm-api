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

async function executeTool(
  call: ToolCall,
  profileId: string
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
      return JSON.stringify(result.rows);
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

  console.log("[WhatsAppBot] profile matched", {
    profileId: profile.id,
    fullName: profile.full_name,
    profilePhoneRaw: profile.phone,
    profilePhoneLocal: toLocalPhoneDigits(profile.phone),
    matchPhoneDigits,
    webhookChatId: chatId,
    replyChatId,
    identitySource,
  });

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

      for (const call of result.toolCalls) {
        const toolResult = await executeTool(call, profile.id);
        messages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: toolResult,
        });
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
