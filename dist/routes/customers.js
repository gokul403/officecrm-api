import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
const router = Router();
// GET /api/customers - List visible customers
router.get("/", requireAuth, async (req, res) => {
    const user = req.user;
    try {
        let query = `
      SELECT c.*, 
             p_assignee.full_name as assignee_name, p_assignee.email as assignee_email
      FROM customers c
      LEFT JOIN profiles p_assignee ON c.assigned_to = p_assignee.id
    `;
        const params = [];
        // RLS: Employees only see customers assigned to them
        if (user.role === "employee") {
            query += " WHERE c.assigned_to = $1";
            params.push(user.id);
        }
        query += " ORDER BY c.name ASC";
        const result = await pool.query(query, params);
        return res.json(result.rows);
    }
    catch (error) {
        console.error("List customers error:", error);
        return res.status(500).json({ message: "Error loading customers" });
    }
});
// POST /api/customers - Create a customer (admin or manager only)
router.post("/", requireAuth, requireRole(["admin", "manager"]), async (req, res) => {
    const { name, email, phone, company, address, status, notes, assigned_to } = req.body;
    const createdBy = req.user.id;
    if (!name) {
        return res.status(400).json({ message: "Customer name is required" });
    }
    try {
        const result = await pool.query(`INSERT INTO customers (name, email, phone, company, address, status, notes, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`, [name, email || null, phone || null, company || null, address || null, status || "active", notes || null, assigned_to || null, createdBy]);
        return res.status(201).json(result.rows[0]);
    }
    catch (error) {
        console.error("Create customer error:", error);
        return res.status(500).json({ message: "Error creating customer" });
    }
});
// PUT /api/customers/:id - Update customer (admin, manager, or assignee)
router.put("/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const updates = req.body;
    try {
        const customerQuery = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
        if (customerQuery.rows.length === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }
        const customer = customerQuery.rows[0];
        const isAssignee = customer.assigned_to === user.id;
        const isAllowed = user.role === "admin" || user.role === "manager" || isAssignee;
        if (!isAllowed) {
            return res.status(403).json({ message: "Forbidden: No permission to update this customer" });
        }
        const fields = [];
        const values = [];
        let valIndex = 1;
        const allowedKeys = ["name", "email", "phone", "company", "address", "status", "notes", "assigned_to"];
        for (const key of allowedKeys) {
            if (updates[key] !== undefined) {
                fields.push(`${key} = $${valIndex++}`);
                values.push(updates[key]);
            }
        }
        if (fields.length === 0) {
            return res.json(customer);
        }
        values.push(id);
        const updateQuery = `
      UPDATE customers 
      SET ${fields.join(", ")}
      WHERE id = $${valIndex}
      RETURNING *
    `;
        const result = await pool.query(updateQuery, values);
        return res.json(result.rows[0]);
    }
    catch (error) {
        console.error("Update customer error:", error);
        return res.status(500).json({ message: "Error updating customer" });
    }
});
// DELETE /api/customers/:id - Delete customer (admin or manager only)
router.delete("/:id", requireAuth, requireRole(["admin", "manager"]), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM customers WHERE id = $1 RETURNING *", [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }
        return res.json({ message: "Customer deleted successfully" });
    }
    catch (error) {
        console.error("Delete customer error:", error);
        return res.status(500).json({ message: "Error deleting customer" });
    }
});
// ================= CUSTOMER INTERACTIONS =================
// GET /api/customers/:customerId/interactions - List interactions
router.get("/:customerId/interactions", requireAuth, async (req, res) => {
    const user = req.user;
    const { customerId } = req.params;
    try {
        // Check access to customer first
        const customerQuery = await pool.query("SELECT * FROM customers WHERE id = $1", [customerId]);
        if (customerQuery.rows.length === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }
        const customer = customerQuery.rows[0];
        if (user.role === "employee" && customer.assigned_to !== user.id) {
            return res.status(403).json({ message: "Forbidden: No access to this customer's interactions" });
        }
        const interactionsQuery = await pool.query(`SELECT i.*, p.full_name as creator_name
       FROM customer_interactions i
       LEFT JOIN profiles p ON i.created_by = p.id
       WHERE i.customer_id = $1
       ORDER BY i.created_at DESC`, [customerId]);
        return res.json(interactionsQuery.rows);
    }
    catch (error) {
        console.error("List interactions error:", error);
        return res.status(500).json({ message: "Error loading interactions" });
    }
});
// POST /api/customers/:customerId/interactions - Create interaction
router.post("/:customerId/interactions", requireAuth, async (req, res) => {
    const user = req.user;
    const { customerId } = req.params;
    const { type, summary } = req.body;
    if (!summary) {
        return res.status(400).json({ message: "Summary content is required" });
    }
    try {
        // Check customer access
        const customerQuery = await pool.query("SELECT * FROM customers WHERE id = $1", [customerId]);
        if (customerQuery.rows.length === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }
        const customer = customerQuery.rows[0];
        if (user.role === "employee" && customer.assigned_to !== user.id) {
            return res.status(403).json({ message: "Forbidden: Cannot log interaction for this customer" });
        }
        const result = await pool.query(`INSERT INTO customer_interactions (customer_id, type, summary, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`, [customerId, type || "note", summary, user.id]);
        return res.status(201).json(result.rows[0]);
    }
    catch (error) {
        console.error("Create interaction error:", error);
        return res.status(500).json({ message: "Error creating interaction" });
    }
});
// DELETE /api/customer-interactions/:id - Delete interaction
router.delete("/interactions/:id", requireAuth, async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    try {
        const interactionQuery = await pool.query("SELECT * FROM customer_interactions WHERE id = $1", [id]);
        if (interactionQuery.rows.length === 0) {
            return res.status(404).json({ message: "Interaction not found" });
        }
        const interaction = interactionQuery.rows[0];
        // Allowed if user is the creator or user is admin
        if (interaction.created_by !== user.id && user.role !== "admin") {
            return res.status(403).json({ message: "Forbidden: Cannot delete this interaction" });
        }
        await pool.query("DELETE FROM customer_interactions WHERE id = $1", [id]);
        return res.json({ message: "Interaction deleted successfully" });
    }
    catch (error) {
        console.error("Delete interaction error:", error);
        return res.status(500).json({ message: "Error deleting interaction" });
    }
});
export default router;
