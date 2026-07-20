import { Router, Response } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth.js";
import { notifyLeadAssignment } from "../services/email.js";
import { notifyAllUsersNewLead } from "../services/lead-notifications.js";

const router = Router();

// GET /api/leads - List all leads (all authenticated roles)
router.get("/", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT l.*, 
             p_assignee.full_name as assignee_name, p_assignee.email as assignee_email
      FROM leads l
      LEFT JOIN profiles p_assignee ON l.assigned_to = p_assignee.id
      ORDER BY l.created_at DESC
    `);
    return res.json(result.rows);
  } catch (error) {
    console.error("List leads error:", error);
    return res.status(500).json({ message: "Error loading leads" });
  }
});

// POST /api/leads - Create a lead (all authenticated roles)
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { name, email, phone, company, source, status, notes, assigned_to, interested_product, possibility, followup_date, expected_revenue } = req.body;
  const createdBy = req.user!.id;

  if (!name) {
    return res.status(400).json({ message: "Lead name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO leads (name, email, phone, company, source, status, notes, assigned_to, created_by, interested_product, possibility, followup_date, expected_revenue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [name, email || null, phone || null, company || null, source || null, status || "new", notes || null, assigned_to || null, createdBy, interested_product || null, possibility || null, followup_date || null, expected_revenue || null,]
    );
    const newLead = result.rows[0];

    if (assigned_to) {
      const assigneeResult = await pool.query(
        "SELECT id, full_name, email FROM profiles WHERE id = $1",
        [assigned_to]
      );
      if (assigneeResult.rows.length > 0) {
        notifyLeadAssignment(newLead, assigneeResult.rows[0]).catch((err) => {
          console.error("[Email Trigger] Fail to send lead assignment email:", err);
        });
      }
    }

    notifyAllUsersNewLead(newLead, createdBy).catch((err) => {
      console.error("[WhatsApp] Fail to broadcast new lead:", err);
    });

    return res.status(201).json(newLead);
  } catch (error) {
    console.error("Create lead error:", error);
    return res.status(500).json({ message: "Error creating lead" });
  }
});

// PUT /api/leads/:id - Update lead (admin, manager, or assignee)
router.put("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const updates = req.body;

  try {
    const leadQuery = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    if (leadQuery.rows.length === 0) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const lead = leadQuery.rows[0];
    const isAssignee = lead.assigned_to === user.id;
    const isAllowed = user.role === "admin" || user.role === "manager" || user.role === "employee" || isAssignee;

    if (!isAllowed) {
      return res.status(403).json({ message: "Forbidden: No permission to update this lead" });
    }

    const fields: string[] = [];
    const values: any[] = [];
    let valIndex = 1;

    const allowedKeys = ["name", "email", "phone", "company", "source", "status", "notes", "assigned_to", "interested_product", "possibility", "followup_date", "expected_revenue"];
    for (const key of allowedKeys) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${valIndex++}`);
        values.push(updates[key]);
      }
    }

    if (fields.length === 0) {
      return res.json(lead);
    }

    values.push(id);
    const updateQuery = `
      UPDATE leads 
      SET ${fields.join(", ")}
      WHERE id = $${valIndex}
      RETURNING *
    `;

    const result = await pool.query(updateQuery, values);
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Update lead error:", error);
    return res.status(500).json({ message: "Error updating lead" });
  }
});

// DELETE /api/leads/:id - Delete lead (admin or manager only)
router.delete("/:id", requireAuth, requireRole(["admin", "manager"]), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM leads WHERE id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Lead not found" });
    }
    return res.json({ message: "Lead deleted successfully" });
  } catch (error) {
    console.error("Delete lead error:", error);
    return res.status(500).json({ message: "Error deleting lead" });
  }
});

export default router;
