import { Router, Response } from "express";
import { pool } from "../config/db.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { notifyLeaveApplication, notifyLeaveStatusChange } from "../services/email.js";

const router = Router();

// GET /api/leaves - List leaves
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user || !user.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    let query: string;
    let params: any[] = [];
    const filterAll = req.query.filter === "all";

    // Admins and managers can see all leaves if requested. Otherwise, only own leaves.
    if ((user.role === "admin" || user.role === "manager") && filterAll) {
      query = `
        SELECT l.*, p.full_name as employee_name, p.email as employee_email,
               p_action.full_name as reviewer_name
        FROM leaves l
        JOIN profiles p ON l.profile_id = p.id
        LEFT JOIN profiles p_action ON l.actioned_by = p_action.id
        ORDER BY l.created_at DESC
      `;
    } else {
      query = `
        SELECT l.*, p.full_name as employee_name, p.email as employee_email,
               p_action.full_name as reviewer_name
        FROM leaves l
        JOIN profiles p ON l.profile_id = p.id
        LEFT JOIN profiles p_action ON l.actioned_by = p_action.id
        WHERE l.profile_id = $1
        ORDER BY l.created_at DESC
      `;
      params = [user.id];
    }

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (error) {
    console.error("List leaves error:", error);
    return res.status(500).json({ message: "Error loading leaves" });
  }
});

// POST /api/leaves - Apply for a leave
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user || !user.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const { start_date, end_date, leave_type, reason } = req.body;

  if (!start_date || !end_date || !leave_type) {
    return res.status(400).json({ message: "Start date, end date, and leave type are required" });
  }

  const validTypes = ['annual', 'sick', 'unpaid', 'wfh', 'other'];
  if (!validTypes.includes(leave_type)) {
    return res.status(400).json({ message: "Invalid leave type" });
  }

  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ message: "End date cannot be before start date" });
  }

  try {
    const query = `
      INSERT INTO leaves (profile_id, start_date, end_date, leave_type, reason, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `;
    const result = await pool.query(query, [
      user.id,
      start_date,
      end_date,
      leave_type,
      reason || null
    ]);

    const createdLeave = result.rows[0];

    // Trigger leave application email notifications
    try {
      const employeeRes = await pool.query(
        "SELECT full_name, email FROM profiles WHERE id = $1",
        [user.id]
      );
      const employee = employeeRes.rows[0];

      const managersRes = await pool.query(`
        SELECT p.email, p.full_name 
        FROM profiles p 
        JOIN user_roles ur ON p.id = ur.user_id 
        WHERE ur.role IN ('admin', 'manager') AND p.is_active = true
      `);
      const managers = managersRes.rows;

      if (employee && managers.length > 0) {
        void notifyLeaveApplication(
          {
            start_date: createdLeave.start_date.toISOString().split("T")[0],
            end_date: createdLeave.end_date.toISOString().split("T")[0],
            leave_type: createdLeave.leave_type,
            reason: createdLeave.reason
          },
          employee,
          managers
        );
      }
    } catch (mailErr) {
      console.error("Failed to send leave application notification emails:", mailErr);
    }

    return res.status(201).json(createdLeave);
  } catch (error) {
    console.error("Apply leave error:", error);
    return res.status(500).json({ message: "Error applying for leave" });
  }
});

// PUT /api/leaves/:id/status - Approve or reject leave
router.put("/:id/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user || !user.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Only admins and managers can action leaves
  if (user.role !== "admin" && user.role !== "manager") {
    return res.status(403).json({ message: "Forbidden: Only managers and admins can approve or reject leaves" });
  }

  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: "Valid status ('approved' or 'rejected') is required" });
  }

  try {
    const query = `
      UPDATE leaves
      SET status = $1, actioned_by = $2, actioned_at = now(), updated_at = now()
      WHERE id = $3
      RETURNING *
    `;
    const result = await pool.query(query, [status, user.id, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    const updatedLeave = result.rows[0];

    // Trigger leave status update email notification to employee
    try {
      const reviewerRes = await pool.query(
        "SELECT full_name FROM profiles WHERE id = $1",
        [user.id]
      );
      const reviewer = reviewerRes.rows[0] || { full_name: "Manager" };

      const employeeRes = await pool.query(`
        SELECT p.full_name, p.email 
        FROM leaves l 
        JOIN profiles p ON l.profile_id = p.id 
        WHERE l.id = $1
      `, [id]);
      const employee = employeeRes.rows[0];

      if (employee) {
        void notifyLeaveStatusChange(
          {
            start_date: updatedLeave.start_date.toISOString().split("T")[0],
            end_date: updatedLeave.end_date.toISOString().split("T")[0],
            leave_type: updatedLeave.leave_type,
            status: updatedLeave.status
          },
          employee,
          reviewer
        );
      }
    } catch (mailErr) {
      console.error("Failed to send leave status email notification:", mailErr);
    }

    return res.json(updatedLeave);
  } catch (error) {
    console.error("Action leave error:", error);
    return res.status(500).json({ message: "Error updating leave request status" });
  }
});

export default router;
