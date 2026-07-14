import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
const router = Router();
// GET /api/projects - List all projects
router.get("/", requireAuth, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
        return res.json(result.rows);
    }
    catch (error) {
        console.error("List projects error:", error);
        return res.status(500).json({ message: "Error loading projects" });
    }
});
// POST /api/projects - Create a new project (Admin only)
router.post("/", requireAuth, requireRole(["admin"]), async (req, res) => {
    const { name, description } = req.body;
    if (!name) {
        return res.status(400).json({ message: "Project name is required" });
    }
    try {
        const result = await pool.query(`INSERT INTO projects (name, description)
       VALUES ($1, $2)
       RETURNING *`, [name, description || null]);
        return res.status(201).json(result.rows[0]);
    }
    catch (error) {
        console.error("Create project error:", error);
        return res.status(500).json({ message: "Error creating project" });
    }
});
export default router;
