import { Router, Response } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// ================= INCOME ROUTES =================

// GET /api/finance/income - List income (all authenticated roles)
router.get("/income", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT i.*, c.name as customer_name
       FROM income i
       LEFT JOIN customers c ON i.customer_id = c.id
       ORDER BY i.received_on DESC, i.created_at DESC`
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("List income error:", error);
    return res.status(500).json({ message: "Error loading income entries" });
  }
});

// POST /api/finance/income - Create income entry
router.post("/income", requireAuth, requireRole(["admin", "manager"]), async (req: AuthenticatedRequest, res: Response) => {
  const { amount, source, category, description, customer_id, received_on } = req.body;
  const createdBy = req.user!.id;

  if (!amount || !source) {
    return res.status(400).json({ message: "Amount and source are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO income (amount, source, category, description, customer_id, received_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [amount, source, category || null, description || null, customer_id || null, received_on || new Date().toISOString().split("T")[0], createdBy]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create income error:", error);
    return res.status(500).json({ message: "Error creating income entry" });
  }
});

// DELETE /api/finance/income/:id - Delete income entry (admin only)
router.delete("/income/:id", requireAuth, requireRole(["admin"]), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM income WHERE id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Income entry not found" });
    }
    return res.json({ message: "Income entry deleted successfully" });
  } catch (error) {
    console.error("Delete income error:", error);
    return res.status(500).json({ message: "Error deleting income entry" });
  }
});

// ================= EXPENSES ROUTES =================

// GET /api/finance/expenses - List expenses (all authenticated roles)
router.get("/expenses", requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT e.*, p.full_name as paid_by_name
       FROM expenses e
       LEFT JOIN profiles p ON e.paid_by = p.id
       ORDER BY e.spent_on DESC, e.created_at DESC`
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("List expenses error:", error);
    return res.status(500).json({ message: "Error loading expenses" });
  }
});

// POST /api/finance/expenses - Create expense (all authenticated roles)
router.post("/expenses", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { amount, category, vendor, description, spent_on, paid_by } = req.body;
  const user = req.user!;
  const createdBy = user.id;
  const payer = paid_by ?? (user.role === "employee" ? createdBy : null);

  if (!amount || !category) {
    return res.status(400).json({ message: "Amount and category are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (amount, category, vendor, description, spent_on, paid_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [amount, category, vendor || null, description || null, spent_on || new Date().toISOString().split("T")[0], payer, createdBy]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create expense error:", error);
    return res.status(500).json({ message: "Error creating expense" });
  }
});

// DELETE /api/finance/expenses/:id - Delete expense (admin only)
router.delete("/expenses/:id", requireAuth, requireRole(["admin"]), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM expenses WHERE id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Expense not found" });
    }
    return res.json({ message: "Expense deleted successfully" });
  } catch (error) {
    console.error("Delete expense error:", error);
    return res.status(500).json({ message: "Error deleting expense" });
  }
});

export default router;
