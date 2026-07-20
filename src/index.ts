import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRouter from "./routes/auth.js";
import tasksRouter from "./routes/tasks.js";
import leadsRouter from "./routes/leads.js";
import customersRouter from "./routes/customers.js";
import financeRouter from "./routes/finance.js";
import teamRouter from "./routes/team.js";
import projectsRouter from "./routes/projects.js";
import { whatsappWebhookHandler } from "./routes/webhooks.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());

// OpenWA webhook needs raw body for HMAC verification — mount before express.json()
app.post(
  "/api/webhooks/whatsapp",
  express.raw({ type: "application/json" }),
  (req, res) => {
    void whatsappWebhookHandler(req, res);
  }
);

app.use(express.json());

// Request logger for development
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// API Routes
app.use("/api/auth", authRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/finance", financeRouter);
app.use("/api", teamRouter); // Mounts /profiles, /team, /team/role, etc.

// Health Check
app.get("/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: new Date() });
});

// Global Error Handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Server Error:", err);
  res.status(500).json({ message: "An unexpected error occurred on the server" });
});

app.listen(PORT, () => {
  console.log(`OfficeFlow server is running on port ${PORT}`);
});
