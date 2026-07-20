/**
 * One-shot backfill of lean task embeddings for RAG.
 * Run after migrate: npx tsx src/scripts/backfill-task-embeddings.ts
 */
import dotenv from "dotenv";
dotenv.config();
import { pool } from "../config/db.js";
import { backfillAllTaskEmbeddings } from "../services/task-embeddings.js";
async function main() {
    console.log("Backfilling task embeddings (lean, ~2KB content each)...");
    const result = await backfillAllTaskEmbeddings();
    console.log("Backfill complete:", result);
    await pool.end();
}
main().catch(async (err) => {
    console.error("Backfill failed:", err);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
