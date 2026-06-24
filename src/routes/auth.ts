import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_officeflow_jwt_token_key_2026";

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    // Fetch user, password hash, profiles, and roles
    const userQuery = await pool.query(
      `SELECT u.id, u.email, u.password_hash, p.full_name, p.avatar_url, p.job_title, p.is_active
       FROM users u
       LEFT JOIN profiles p ON p.id = u.id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = userQuery.rows[0];

    // Check if account is active
    if (user.is_active === false) {
      return res.status(403).json({ message: "Account is disabled. Please contact your administrator." });
    }

    // Verify password
    const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Fetch user roles
    const rolesQuery = await pool.query(
      "SELECT role FROM user_roles WHERE user_id = $1",
      [user.id]
    );
    const roles = rolesQuery.rows.map((r) => r.role);
    const primaryRole = roles[0] || "employee";

    // Create token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: primaryRole,
        roles: roles,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Return token and profile
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
      },
      profile: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        job_title: user.job_title,
        is_active: user.is_active,
      },
      roles,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const userQuery = await pool.query(
      `SELECT u.id, u.email, p.full_name, p.avatar_url, p.job_title, p.is_active
       FROM users u
       LEFT JOIN profiles p ON p.id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    if (user.is_active === false) {
      return res.status(403).json({ message: "Account disabled" });
    }

    const rolesQuery = await pool.query(
      "SELECT role FROM user_roles WHERE user_id = $1",
      [req.user.id]
    );
    const roles = rolesQuery.rows.map((r) => r.role);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
      },
      profile: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        job_title: user.job_title,
        is_active: user.is_active,
      },
      roles,
    });
  } catch (error) {
    console.error("Fetch me error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
