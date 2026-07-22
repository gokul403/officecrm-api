import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { notifyIssueAssignment } from "../services/email.js";
const router = Router();
// GET /api/issues - List all issues
router.get("/", requireAuth, async (req, res) => {
    try {
        const query = `
      SELECT i.*,
             p.name as project_name, p.project_code as project_code,
             p_assignee.full_name as assignee_name, p_assignee.email as assignee_email,
             p_creator.full_name as creator_name, p_creator.email as creator_email
      FROM issues i
      LEFT JOIN projects p ON i.project_id = p.id
      LEFT JOIN profiles p_assignee ON i.assigned_to = p_assignee.id
      LEFT JOIN profiles p_creator ON i.created_by = p_creator.id
      ORDER BY i.created_at DESC
    `;
        const result = await pool.query(query);
        return res.json(result.rows);
    }
    catch (error) {
        console.error("List issues error:", error);
        return res.status(500).json({ message: "Error loading issues" });
    }
});
// POST /api/issues - Create a new issue
router.post("/", requireAuth, async (req, res) => {
    const { title, description, status, priority, assigned_to, project_id } = req.body;
    if (!title) {
        return res.status(400).json({ message: "Title is required" });
    }
    if (!project_id) {
        return res.status(400).json({ message: "Project is required" });
    }
    try {
        const creatorId = req.user?.id;
        const query = `
      INSERT INTO issues (title, description, status, priority, assigned_to, created_by, project_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
        const result = await pool.query(query, [
            title,
            description || null,
            status || "backlog",
            priority || "medium",
            assigned_to || null,
            creatorId || null,
            project_id,
        ]);
        const createdIssue = result.rows[0];
        // Trigger email notification if assigned on creation
        if (assigned_to) {
            const profileRes = await pool.query("SELECT full_name, email FROM profiles WHERE id = $1", [assigned_to]);
            if (profileRes.rows.length > 0) {
                notifyIssueAssignment({ title, description, priority: priority || "medium", status: status || "backlog" }, profileRes.rows[0]).catch(err => console.error("Error sending issue assignment email:", err));
            }
        }
        return res.status(201).json(createdIssue);
    }
    catch (error) {
        console.error("Create issue error:", error);
        return res.status(500).json({ message: "Error creating issue" });
    }
});
// PUT /api/issues/:id - Update an issue
router.put("/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { title, description, status, priority, assigned_to, project_id } = req.body;
    if (!title) {
        return res.status(400).json({ message: "Title is required" });
    }
    if (!project_id) {
        return res.status(400).json({ message: "Project is required" });
    }
    try {
        // Get the previous assignee to check if it has changed
        const prevIssueRes = await pool.query("SELECT assigned_to FROM issues WHERE id = $1", [id]);
        const prevAssignedTo = prevIssueRes.rows[0]?.assigned_to;
        const query = `
      UPDATE issues
      SET title = $1, description = $2, status = $3, priority = $4, assigned_to = $5, project_id = $6, updated_at = now()
      WHERE id = $7
      RETURNING *
    `;
        const result = await pool.query(query, [
            title,
            description || null,
            status || "backlog",
            priority || "medium",
            assigned_to || null,
            project_id,
            id
        ]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Issue not found" });
        }
        const updatedIssue = result.rows[0];
        // Trigger email notification if assignee changed and is not null
        if (assigned_to && assigned_to !== prevAssignedTo) {
            const profileRes = await pool.query("SELECT full_name, email FROM profiles WHERE id = $1", [assigned_to]);
            if (profileRes.rows.length > 0) {
                notifyIssueAssignment({ title, description, priority: priority || "medium", status: status || "backlog" }, profileRes.rows[0]).catch(err => console.error("Error sending issue assignment email:", err));
            }
        }
        return res.json(updatedIssue);
    }
    catch (error) {
        console.error("Update issue error:", error);
        return res.status(500).json({ message: "Error updating issue" });
    }
});
// DELETE /api/issues/:id - Delete an issue
router.delete("/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM issues WHERE id = $1 RETURNING *", [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Issue not found" });
        }
        return res.json({ message: "Issue deleted successfully" });
    }
    catch (error) {
        console.error("Delete issue error:", error);
        return res.status(500).json({ message: "Error deleting issue" });
    }
});
export default router;
