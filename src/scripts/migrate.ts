import { pool } from "../config/db.js";
import bcrypt from "bcryptjs";

const DEMO_USERS = [
  { email: "admin@demo.com", password: "Admin1234!", fullName: "Admin User", role: "admin", jobTitle: "Workspace Admin" },
  { email: "manager@demo.com", password: "Manager1234!", fullName: "Manager User", role: "manager", jobTitle: "Operations Manager" },
  { email: "employee1@demo.com", password: "Employee1234!", fullName: "Employee One", role: "employee", jobTitle: "Account Executive" },
  { email: "employee2@demo.com", password: "Employee1234!", fullName: "Employee Two", role: "employee", jobTitle: "Support Specialist" },
  { email: "employee3@demo.com", password: "Employee1234!", fullName: "Employee Three", role: "employee", jobTitle: "Sales Associate" },
];

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Starting database migration on Aiven PostgreSQL...");
    await client.query("BEGIN");

    // 1. Extensions
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // 2. Enums
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
          CREATE TYPE app_role AS ENUM ('admin', 'manager', 'employee');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
          CREATE TYPE task_status AS ENUM ('pending', 'in_progress', 'completed', 'overdue');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_priority') THEN
          CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
          CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_status') THEN
          CREATE TYPE customer_status AS ENUM ('active', 'inactive', 'prospect');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'interaction_type') THEN
          CREATE TYPE interaction_type AS ENUM ('call', 'email', 'meeting', 'note');
        END IF;
      END $$;
    `);

    // 3. Tables
    console.log("Creating tables...");

    // USERS (Custom authentication table)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // PROFILES
    await client.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        full_name TEXT,
        avatar_url TEXT,
        job_title TEXT,
        manager_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // USER ROLES
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role app_role NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, role)
      )
    `);

    // TASKS
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT,
        status task_status NOT NULL DEFAULT 'pending',
        priority task_priority NOT NULL DEFAULT 'medium',
        due_date TIMESTAMPTZ,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // TASK ASSIGNEES (Junction table for multiple assignees)
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_assignees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (task_id, profile_id)
      )
    `);

    // Data migration: Copy existing assigned_to in tasks to task_assignees and drop column
    const hasAssignedToCol = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='tasks' AND column_name='assigned_to'
    `);
    if (hasAssignedToCol.rows.length > 0) {
      console.log("Migrating existing tasks.assigned_to data to task_assignees table...");
      await client.query(`
        INSERT INTO task_assignees (task_id, profile_id)
        SELECT id, assigned_to FROM tasks
        WHERE assigned_to IS NOT NULL
        ON CONFLICT (task_id, profile_id) DO NOTHING
      `);
      console.log("Dropping assigned_to column from tasks table...");
      await client.query(`ALTER TABLE tasks DROP COLUMN assigned_to`);
    }

    // COMMENTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // LEADS
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        source TEXT,
        status lead_status NOT NULL DEFAULT 'new',
        notes TEXT,
        assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        interested_product TEXT,
        possibility TEXT,
        followup_date TIMESTAMPTZ,
        expected_revenue NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // CUSTOMERS
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        address TEXT,
        status customer_status NOT NULL DEFAULT 'active',
        notes TEXT,
        assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // CUSTOMER INTERACTIONS
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_interactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        type interaction_type NOT NULL DEFAULT 'note',
        summary TEXT NOT NULL,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // INCOME
    await client.query(`
      CREATE TABLE IF NOT EXISTS income (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
        source TEXT NOT NULL,
        category TEXT,
        description TEXT,
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        received_on DATE NOT NULL DEFAULT CURRENT_DATE,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // EXPENSES
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
        category TEXT NOT NULL,
        vendor TEXT,
        description TEXT,
        spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
        paid_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 4. Triggers
    console.log("Setting up updated_at trigger...");
    await client.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const tablesForTrigger = ["users", "profiles", "tasks", "leads", "customers", "income", "expenses"];
    for (const table of tablesForTrigger) {
      await client.query(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
      await client.query(`
        CREATE TRIGGER trg_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      `);
    }

    // 5. Seed Users & Profiles
    console.log("Seeding users and profiles...");
    const userIds: Record<string, string> = {};

    for (const u of DEMO_USERS) {
      // Check if user exists
      const existingUser = await client.query("SELECT id FROM users WHERE email = $1", [u.email]);
      let userId: string;

      if (existingUser.rows.length === 0) {
        // Hash password
        const passwordHash = bcrypt.hashSync(u.password, 10);
        // Insert into users
        const userInsert = await client.query(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
          [u.email, passwordHash]
        );
        userId = userInsert.rows[0].id;

        // Insert into profiles
        await client.query(
          "INSERT INTO profiles (id, email, full_name, job_title) VALUES ($1, $2, $3, $4)",
          [userId, u.email, u.fullName, u.jobTitle]
        );

        // Insert into user_roles
        await client.query(
          "INSERT INTO user_roles (user_id, role) VALUES ($1, $2)",
          [userId, u.role]
        );
      } else {
        userId = existingUser.rows[0].id;
      }
      userIds[u.email] = userId;
    }

    // Connect employees to manager
    const managerId = userIds["manager@demo.com"];
    if (managerId) {
      await client.query(
        "UPDATE profiles SET manager_id = $1 WHERE email IN ('employee1@demo.com', 'employee2@demo.com', 'employee3@demo.com')",
        [managerId]
      );
    }

    // 6. Seed Demo Data (CRM & Tasks)
    const tasksCount = await client.query("SELECT count(*) FROM tasks");
    if (parseInt(tasksCount.rows[0].count) === 0) {
      console.log("Seeding tasks, leads, customers, financial transactions...");
      const adminId = userIds["admin@demo.com"];
      const employee1Id = userIds["employee1@demo.com"];

      // 6a. Leads
      await client.query(`
        INSERT INTO leads (name, email, phone, company, source, status, notes, assigned_to, created_by) VALUES
        ('Acme Corp', 'hello@acme.io', '+1 555 0100', 'Acme Corp', 'Website', 'new', 'Wants pricing for 50 seats', '${employee1Id}', '${managerId}'),
        ('Globex LLC', 'sales@globex.io', '+1 555 0111', 'Globex', 'Referral', 'contacted', 'Follow up next week', '${employee1Id}', '${managerId}'),
        ('Initech', 'tps@initech.com', '+1 555 0122', 'Initech', 'Cold call', 'qualified', 'Demo scheduled', '${managerId}', '${managerId}'),
        ('Umbrella Co', 'ops@umbrella.io', '+1 555 0133', 'Umbrella', 'LinkedIn', 'proposal', 'Sent proposal v2', '${managerId}', '${adminId}');
      `);

      // 6b. Customers
      await client.query(`
        INSERT INTO customers (name, email, phone, company, address, status, assigned_to, created_by) VALUES
        ('Stark Industries', 'tony@stark.io', '+1 555 0200', 'Stark Industries', 'Malibu, CA', 'active', '${managerId}', '${adminId}'),
        ('Wayne Enterprises', 'bruce@wayne.io', '+1 555 0201', 'Wayne Enterprises', 'Gotham', 'active', '${employee1Id}', '${adminId}');
      `);

      const cust1 = (await client.query("SELECT id FROM customers WHERE name = 'Stark Industries'")).rows[0].id;
      const cust2 = (await client.query("SELECT id FROM customers WHERE name = 'Wayne Enterprises'")).rows[0].id;

      // 6c. Interactions
      await client.query(`
        INSERT INTO customer_interactions (customer_id, type, summary, created_by) VALUES
        ('${cust1}', 'call', 'Quarterly check-in call. All good.', '${managerId}'),
        ('${cust1}', 'email', 'Sent updated SLA document.', '${employee1Id}'),
        ('${cust2}', 'meeting', 'On-site review meeting.', '${managerId}');
      `);

      // 6d. Income
      await client.query(`
        INSERT INTO income (amount, source, category, description, customer_id, received_on, created_by) VALUES
        (12500.00, 'Stark Industries', 'Services', 'Q1 retainer', '${cust1}', CURRENT_DATE - 20, '${adminId}'),
        (4800.00, 'Wayne Enterprises', 'License', 'Annual license renewal', '${cust2}', CURRENT_DATE - 10, '${adminId}'),
        (2200.00, 'Stark Industries', 'Consulting', 'Strategy workshop', '${cust1}', CURRENT_DATE - 3, '${managerId}');
      `);

      // 6e. Expenses
      await client.query(`
        INSERT INTO expenses (amount, category, vendor, description, spent_on, paid_by, created_by) VALUES
        (1200.00, 'Software', 'Atlassian', 'Jira annual', CURRENT_DATE - 25, '${adminId}', '${adminId}'),
        (340.00, 'Office', 'Staples', 'Office supplies', CURRENT_DATE - 15, '${managerId}', '${managerId}'),
        (2500.00, 'Marketing', 'Meta Ads', 'Q1 campaign', CURRENT_DATE - 8, '${managerId}', '${adminId}'),
        (680.00, 'Travel', 'Delta', 'Client visit flights', CURRENT_DATE - 2, '${managerId}', '${adminId}');
      `);

      // 6f. Tasks
      const SAMPLE_TASKS = [
        { title: "Onboard Acme Corp", description: "Send welcome packet and schedule kick-off call.", priority: "high", status: "in_progress", offsetDays: 2, assigneeId: employee1Id, createdBy: managerId },
        { title: "Quarterly performance review prep", description: "Compile KPIs for Q review.", priority: "medium", status: "pending", offsetDays: 7, assigneeId: employee1Id, createdBy: managerId },
        { title: "Fix invoice template footer", description: "Logo overlapping address block.", priority: "low", status: "pending", offsetDays: 4, assigneeId: employee1Id, createdBy: managerId },
        { title: "Follow up with Globex lead", description: "Send proposal v2 with updated pricing.", priority: "critical", status: "pending", offsetDays: 1, assigneeId: managerId, createdBy: managerId },
        { title: "Update employee handbook", description: "Add new PTO policy.", priority: "medium", status: "completed", offsetDays: -3, assigneeId: userIds["employee2@demo.com"], createdBy: adminId },
        { title: "Renew SSL certificate", description: "Production cert expires soon.", priority: "high", status: "in_progress", offsetDays: 10, assigneeId: userIds["employee3@demo.com"], createdBy: adminId },
      ];

      for (const t of SAMPLE_TASKS) {
        const dueDate = new Date(Date.now() + t.offsetDays * 86400000).toISOString();
        const completedAt = t.status === "completed" ? new Date().toISOString() : null;
        
        const taskInsert = await client.query(
          `INSERT INTO tasks (title, description, priority, status, due_date, created_by, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [t.title, t.description, t.priority, t.status, dueDate, t.createdBy, completedAt]
        );
        const taskId = taskInsert.rows[0].id;
        
        if (t.assigneeId) {
          await client.query(
            `INSERT INTO task_assignees (task_id, profile_id) VALUES ($1, $2)`,
            [taskId, t.assigneeId]
          );
        }
      }
    }

    await client.query("COMMIT");
    console.log("Database schema migrated and seeded successfully!");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((e) => {
  console.error("Unhandle migration error:", e);
  process.exit(1);
});
