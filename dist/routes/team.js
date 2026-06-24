import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
const router = Router();
// GET /api/profiles - General route open to all authenticated users (assignee lists, etc.)
router.get("/profiles", requireAuth, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, email, full_name, avatar_url, job_title, is_active FROM profiles ORDER BY full_name ASC");
        return res.json(result.rows);
    }
    catch (error) {
        console.error("List profiles error:", error);
        return res.status(500).json({ message: "Error loading profiles" });
    }
});
// GET /api/team - List profiles and user_roles (admin and manager only)
router.get("/team", requireAuth, requireRole(["admin", "manager"]), async (req, res) => {
    try {
        const profilesResult = await pool.query("SELECT id, email, full_name, avatar_url, job_title, is_active, manager_id FROM profiles ORDER BY email ASC");
        const rolesResult = await pool.query("SELECT user_id, role FROM user_roles");
        return res.json({
            profiles: profilesResult.rows,
            roles: rolesResult.rows,
        });
    }
    catch (error) {
        console.error("Get team details error:", error);
        return res.status(500).json({ message: "Error loading team details" });
    }
});
// POST /api/team/role - Update user role (admin only)
router.post("/team/role", requireAuth, requireRole(["admin"]), async (req, res) => {
    const { userId, role } = req.body;
    if (!userId || !role) {
        return res.status(400).json({ message: "userId and role are required" });
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Replace roles (delete then insert)
        await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
        await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [userId, role]);
        await client.query("COMMIT");
        return res.json({ ok: true });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("Update role error:", error);
        return res.status(500).json({ message: "Error updating user role" });
    }
    finally {
        client.release();
    }
});
// POST /api/team/active - Toggle user active status (admin only)
router.post("/team/active", requireAuth, requireRole(["admin"]), async (req, res) => {
    const { userId, active } = req.body;
    if (!userId || active === undefined) {
        return res.status(400).json({ message: "userId and active boolean are required" });
    }
    try {
        await pool.query("UPDATE profiles SET is_active = $1 WHERE id = $2", [active, userId]);
        return res.json({ ok: true });
    }
    catch (error) {
        console.error("Toggle active error:", error);
        return res.status(500).json({ message: "Error updating user status" });
    }
});
// POST /api/team/seed - Re-seed or create demo data (admin only)
router.post("/team/seed", requireAuth, requireRole(["admin"]), async (req, res) => {
    const callerId = req.user.id;
    const DEMO_PASSWORD = "Demo1234!";
    const DEMO_USERS = [
        { email: "manager1@demo.com", fullName: "Morgan Lee", role: "manager", jobTitle: "Operations Manager" },
        { email: "employee1@demo.com", fullName: "Alex Chen", role: "employee", jobTitle: "Account Executive" },
        { email: "employee2@demo.com", fullName: "Priya Patel", role: "employee", jobTitle: "Support Specialist" },
        { email: "employee3@demo.com", fullName: "Diego Ramirez", role: "employee", jobTitle: "Sales Associate" },
    ];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        console.log("Seeding demo data from backend...");
        const createdProfiles = [];
        for (const u of DEMO_USERS) {
            let userId;
            const checkUser = await client.query("SELECT id FROM users WHERE email = $1", [u.email]);
            if (checkUser.rows.length === 0) {
                const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
                const userInsert = await client.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id", [u.email, passwordHash]);
                userId = userInsert.rows[0].id;
                await client.query("INSERT INTO profiles (id, email, full_name, job_title) VALUES ($1, $2, $3, $4)", [userId, u.email, u.fullName, u.jobTitle]);
                await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [userId, u.role]);
            }
            else {
                userId = checkUser.rows[0].id;
                await client.query("UPDATE profiles SET full_name = $1, job_title = $2 WHERE id = $3", [u.fullName, u.jobTitle, userId]);
                await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id, role) DO NOTHING", [userId, u.role]);
            }
            createdProfiles.push({ id: userId, email: u.email, role: u.role });
        }
        // Connect employees to manager
        const manager = createdProfiles.find((p) => p.role === "manager");
        const employees = createdProfiles.filter((p) => p.role === "employee");
        if (manager) {
            await client.query("UPDATE profiles SET manager_id = $1 WHERE id = ANY($2::uuid[])", [manager.id, employees.map((e) => e.id)]);
        }
        // Seed tasks if empty
        const tasksCount = await client.query("SELECT count(*) FROM tasks");
        if (parseInt(tasksCount.rows[0].count) === 0) {
            const allAssignees = [callerId, ...employees.map((e) => e.id)];
            const now = Date.now();
            const SAMPLE_TASKS = [
                { title: "Onboard Acme Corp", description: "Send welcome packet and schedule kick-off call.", priority: "high", status: "in_progress", offsetDays: 2 },
                { title: "Quarterly performance review prep", description: "Compile KPIs for Q review.", priority: "medium", status: "pending", offsetDays: 7 },
                { title: "Fix invoice template footer", description: "Logo overlapping address block.", priority: "low", status: "pending", offsetDays: 4 },
                { title: "Follow up with Globex lead", description: "Send proposal v2 with updated pricing.", priority: "critical", status: "pending", offsetDays: 1 },
                { title: "Update employee handbook", description: "Add new PTO policy.", priority: "medium", status: "completed", offsetDays: -3 },
                { title: "Renew SSL certificate", description: "Production cert expires soon.", priority: "high", status: "in_progress", offsetDays: 10 },
            ];
            for (let i = 0; i < SAMPLE_TASKS.length; i++) {
                const t = SAMPLE_TASKS[i];
                const assignedTo = allAssignees[i % allAssignees.length];
                const dueDate = new Date(now + t.offsetDays * 86400000).toISOString();
                const completedAt = t.status === "completed" ? new Date().toISOString() : null;
                await client.query(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, created_by, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [t.title, t.description, t.priority, t.status, dueDate, assignedTo, callerId, completedAt]);
            }
        }
        await client.query("COMMIT");
        return res.json({
            ok: true,
            created: createdProfiles.length,
            credentials: DEMO_USERS.map((u) => ({ email: u.email, password: DEMO_PASSWORD, role: u.role })),
        });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("Seeding error:", error);
        return res.status(500).json({ message: "Seeding demo data failed" });
    }
    finally {
        client.release();
    }
});
export default router;
