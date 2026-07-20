import { Router, Response } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth.js";
import { notifyTaskAssignment, notifyTaskUpdate } from "../services/email.js";
import { buildTaskAssignedMessage, sendWhatsAppMessage } from "../services/whatsapp.js";
import { scheduleTaskEmbedding } from "../services/task-embeddings.js";

const router = Router();

async function notifyTaskAssignee(
  assignedToId: string,
  assignerId: string,
  task: { title: string; priority?: string | null; due_date?: string | Date | null }
): Promise<void> {
  console.log("[WhatsApp] notifyTaskAssignee start", {
    assignedToId,
    assignerId,
    taskTitle: task.title,
  });

  try {
    const profileResult = await pool.query(
      `SELECT assignee.phone, assignee.full_name AS assignee_name, assignee.email AS assignee_email,
              assigner.full_name AS assigner_name
       FROM profiles assignee
       LEFT JOIN profiles assigner ON assigner.id = $2
       WHERE assignee.id = $1`,
      [assignedToId, assignerId]
    );

    if (profileResult.rows.length === 0) {
      console.warn("[WhatsApp] Skipped (assignee profile not found)", { assignedToId });
      return;
    }

    const {
      phone,
      assignee_name: assigneeName,
      assignee_email: assigneeEmail,
      assigner_name: assignerName,
    } = profileResult.rows[0];

    console.log("[WhatsApp] Assignee profile loaded", {
      assignedToId,
      assigneeName,
      assigneeEmail,
      hasPhone: Boolean(phone),
      phone: phone ?? null,
    });

    if (!phone) {
      console.log(`[WhatsApp] Skipped (no phone for assignee ${assignedToId})`);
      return;
    }

    const message = buildTaskAssignedMessage(task, assignerName ?? "Someone");
    console.log("[WhatsApp] Sending assignment message", {
      assignedToId,
      phone,
      messagePreview: message.slice(0, 120),
    });
    await sendWhatsAppMessage(phone, message);
    console.log("[WhatsApp] notifyTaskAssignee finished", { assignedToId });
  } catch (error) {
    console.error("[WhatsApp] notifyTaskAssignee error:", error);
  }
}

// GET /api/tasks - List visible tasks
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = `
      SELECT t.*, 
             p.name as project_name,
             p.project_code as project_code,
             coalesce(
               json_agg(
                 json_build_object('id', p_assignee.id, 'full_name', p_assignee.full_name, 'email', p_assignee.email)
               ) FILTER (WHERE p_assignee.id IS NOT NULL),
               '[]'
             ) as assignees,
             p_creator.full_name as creator_name, p_creator.email as creator_email
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN profiles p_assignee ON ta.profile_id = p_assignee.id
      LEFT JOIN profiles p_creator ON t.created_by = p_creator.id
      GROUP BY t.id, p.id, p_creator.id
      ORDER BY t.due_date ASC, t.created_at DESC
    `;
    const result = await pool.query(query);
    return res.json(result.rows);
  } catch (error) {
    console.error("List tasks error:", error);
    return res.status(500).json({ message: "Error loading tasks" });
  }
});

// GET /api/tasks/:id - Fetch single task
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT t.*, 
             p.name as project_name,
             p.project_code as project_code,
             coalesce(
               json_agg(
                 json_build_object('id', p_assignee.id, 'full_name', p_assignee.full_name, 'email', p_assignee.email)
               ) FILTER (WHERE p_assignee.id IS NOT NULL),
               '[]'
             ) as assignees
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN profiles p_assignee ON ta.profile_id = p_assignee.id
      WHERE t.id = $1
      GROUP BY t.id, p.id
    `;
    const taskQuery = await pool.query(query, [id]);
    if (taskQuery.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    const task = taskQuery.rows[0];
    return res.json(task);
  } catch (error) {
    console.error("Get task error:", error);
    return res.status(500).json({ message: "Error loading task" });
  }
});

// POST /api/tasks - Create task (admin or manager only)
router.post("/", requireAuth, requireRole(["admin", "manager"]), async (req: AuthenticatedRequest, res: Response) => {
  const { title, description, status, priority, due_date, assignee_ids, project_id } = req.body;
  const createdBy = req.user!.id;

  if (!title) {
    return res.status(400).json({ message: "Title is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO tasks (title, description, status, priority, due_date, created_by, completed_at, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        title,
        description || null,
        status || "pending",
        priority || "medium",
        due_date || null,
        createdBy,
        status === "completed" ? new Date().toISOString() : null,
        project_id || null,
      ]
    );
    const initialTask = result.rows[0];
    
    const newTaskResult = await client.query(
      `SELECT t.*, p.name as project_name, p.project_code as project_code
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.id = $1`,
      [initialTask.id]
    );
    const newTask = newTaskResult.rows[0];

    const assignees: any[] = [];
    if (Array.isArray(assignee_ids) && assignee_ids.length > 0) {
      for (const assigneeId of assignee_ids) {
        if (!assigneeId) continue;
        await client.query(
          `INSERT INTO task_assignees (task_id, profile_id) VALUES ($1, $2)`,
          [newTask.id, assigneeId]
        );
        const pResult = await client.query(
          `SELECT id, full_name, email FROM profiles WHERE id = $1`,
          [assigneeId]
        );
        if (pResult.rows.length > 0) {
          assignees.push(pResult.rows[0]);
        }
      }
    }

    await client.query("COMMIT");

    if (assignees.length > 0) {
      console.log("[WhatsApp] Task created — notifying assignees", {
        taskId: newTask.id,
        assigneeIds: assignees.map((a) => a.id),
      });
      notifyTaskAssignment(newTask, assignees).catch((err) => {
        console.error("[Email Trigger] Fail to send assignment emails:", err);
      });
      for (const assignee of assignees) {
        notifyTaskAssignee(assignee.id, createdBy, newTask).catch((err) => {
          console.error("[WhatsApp] Fail to notify assignee on create:", err);
        });
      }
    } else {
      console.log("[WhatsApp] Task created — no assignees to notify", { taskId: newTask.id });
    }

    scheduleTaskEmbedding(newTask.id);

    return res.status(201).json({
      ...newTask,
      assignees
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create task error:", error);
    return res.status(500).json({ message: "Error creating task" });
  } finally {
    client.release();
  }
});

// PUT /api/tasks/:id - Update task (admin, manager, or assignee)
router.put("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const updates = req.body;

  try {
    const taskQuery = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (taskQuery.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    const task = taskQuery.rows[0];

    // RLS: only admin, manager, employee, or assignee can update
    const assigneeCheck = await pool.query(
      "SELECT 1 FROM task_assignees WHERE task_id = $1 AND profile_id = $2",
      [id, user.id]
    );
    const isAssignee = assigneeCheck.rows.length > 0;
    const isAllowed = user.role === "admin" || user.role === "manager" || user.role === "employee" || isAssignee;

    if (!isAllowed) {
      return res.status(403).json({ message: "Forbidden: No permission to update this task" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const previousAssigneesResult = await client.query(
        "SELECT profile_id FROM task_assignees WHERE task_id = $1",
        [id]
      );
      const previousAssigneeIds = new Set(
        previousAssigneesResult.rows.map((row: { profile_id: string }) => row.profile_id)
      );

      const fields: string[] = [];
      const values: any[] = [];
      let valIndex = 1;

      const allowedKeys = ["title", "description", "status", "priority", "due_date", "completed_at", "project_id"];

      for (const key of allowedKeys) {
        if (updates[key] !== undefined) {
          fields.push(`${key} = $${valIndex++}`);
          values.push(updates[key]);
        }
      }

      if (updates.status !== undefined && updates.completed_at === undefined) {
        fields.push(`completed_at = $${valIndex++}`);
        values.push(updates.status === "completed" ? new Date().toISOString() : null);
      }

      if (fields.length > 0) {
        values.push(id);
        const updateQuery = `
          UPDATE tasks 
          SET ${fields.join(", ")}
          WHERE id = $${valIndex}
        `;
        await client.query(updateQuery, values);
      }

      if (updates.assignee_ids !== undefined) {
        await client.query("DELETE FROM task_assignees WHERE task_id = $1", [id]);
        if (Array.isArray(updates.assignee_ids) && updates.assignee_ids.length > 0) {
          for (const assigneeId of updates.assignee_ids) {
            if (!assigneeId) continue;
            await client.query(
              "INSERT INTO task_assignees (task_id, profile_id) VALUES ($1, $2)",
              [id, assigneeId]
            );
          }
        }
      }

      const assigneesResult = await client.query(
        `SELECT p.id, p.full_name, p.email 
         FROM task_assignees ta
         JOIN profiles p ON ta.profile_id = p.id
         WHERE ta.task_id = $1`,
        [id]
      );

      // Fetch fully populated updated task details with project information
      const populatedResult = await client.query(`
        SELECT t.*, pr.name as project_name, pr.project_code as project_code
        FROM tasks t
        LEFT JOIN projects pr ON t.project_id = pr.id
        WHERE t.id = $1
      `, [id]);
      const updatedTask = populatedResult.rows[0];

      await client.query("COMMIT");

      if (assigneesResult.rows.length > 0) {
        notifyTaskUpdate(updatedTask, assigneesResult.rows).catch((err) => {
          console.error("[Email Trigger] Fail to send update emails:", err);
        });
      }

      if (updates.assignee_ids !== undefined) {
        const newlyAssigned = assigneesResult.rows.filter(
          (assignee: { id: string }) => !previousAssigneeIds.has(assignee.id)
        );
        console.log("[WhatsApp] Task assignees updated", {
          taskId: id,
          previousCount: previousAssigneeIds.size,
          currentIds: assigneesResult.rows.map((a: { id: string }) => a.id),
          newlyAssignedIds: newlyAssigned.map((a: { id: string }) => a.id),
        });
        for (const assignee of newlyAssigned) {
          notifyTaskAssignee(assignee.id, user.id, updatedTask).catch((err) => {
            console.error("[WhatsApp] Fail to notify assignee on update:", err);
          });
        }
      }

      scheduleTaskEmbedding(id);

      return res.json({
        ...updatedTask,
        assignees: assigneesResult.rows
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Update task error:", error);
      return res.status(500).json({ message: "Error updating task" });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Update task main error:", error);
    return res.status(500).json({ message: "Error updating task" });
  }
});

// DELETE /api/tasks/:id - Delete task (admin only)
router.delete("/:id", requireAuth, requireRole(["admin"]), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM tasks WHERE id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }
    return res.json({ message: "Task deleted successfully" });
  } catch (error) {
    console.error("Delete task error:", error);
    return res.status(500).json({ message: "Error deleting task" });
  }
});

// ================= COMMENTS ROUTES =================

// GET /api/tasks/:taskId/comments - Get comments for a task
router.get("/:taskId/comments", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user!;
  const { taskId } = req.params;

  try {
    const taskQuery = await pool.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
    if (taskQuery.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }
    const task = taskQuery.rows[0];

    const assigneeCheck = await pool.query(
      "SELECT 1 FROM task_assignees WHERE task_id = $1 AND profile_id = $2",
      [taskId, user.id]
    );
    const isAssignee = assigneeCheck.rows.length > 0;

    if (user.role === "employee" && !isAssignee && task.created_by !== user.id) {
      return res.status(403).json({ message: "Forbidden: No access to this task's comments" });
    }

    const commentsQuery = await pool.query(
      `SELECT c.*, p.full_name as author_name, p.avatar_url as author_avatar, p.email as author_email
       FROM task_comments c
       LEFT JOIN profiles p ON c.user_id = p.id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [taskId]
    );

    return res.json(commentsQuery.rows);
  } catch (error) {
    console.error("List task comments error:", error);
    return res.status(500).json({ message: "Error loading comments" });
  }
});

// POST /api/tasks/:taskId/comments - Create comment
router.post("/:taskId/comments", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user!;
  const { taskId } = req.params;
  const { content } = req.body;

  if (!content) {
    return res.status(400).json({ message: "Comment content is required" });
  }

  try {
    const taskQuery = await pool.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
    if (taskQuery.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }
    const task = taskQuery.rows[0];

    const assigneeCheck = await pool.query(
      "SELECT 1 FROM task_assignees WHERE task_id = $1 AND profile_id = $2",
      [taskId, user.id]
    );
    const isAssignee = assigneeCheck.rows.length > 0;

    if (user.role === "employee" && !isAssignee && task.created_by !== user.id) {
      return res.status(403).json({ message: "Forbidden: Cannot comment on this task" });
    }

    const result = await pool.query(
      `INSERT INTO task_comments (task_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [taskId, user.id, content]
    );

    scheduleTaskEmbedding(taskId);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create comment error:", error);
    return res.status(500).json({ message: "Error creating comment" });
  }
});

// DELETE /api/task-comments/:id - Delete comment
router.delete("/comments/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  try {
    const commentQuery = await pool.query("SELECT * FROM task_comments WHERE id = $1", [id]);
    if (commentQuery.rows.length === 0) {
      return res.status(404).json({ message: "Comment not found" });
    }

    const comment = commentQuery.rows[0];

    if (comment.user_id !== user.id && user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: Cannot delete this comment" });
    }

    await pool.query("DELETE FROM task_comments WHERE id = $1", [id]);
    scheduleTaskEmbedding(comment.task_id);
    return res.json({ message: "Comment deleted successfully" });
  } catch (error) {
    console.error("Delete comment error:", error);
    return res.status(500).json({ message: "Error deleting comment" });
  }
});

export default router;
