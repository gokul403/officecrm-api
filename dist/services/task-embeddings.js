import { pool } from "../config/db.js";
import { getAIProvider } from "../ai/index.js";
const MAX_CONTENT_BYTES = 2048;
const MAX_COMMENT_CHARS = 120;
const MAX_RECENT_COMMENTS = 3;
const TOP_K = 5;
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
function capContent(text) {
    if (Buffer.byteLength(text, "utf8") <= MAX_CONTENT_BYTES)
        return text;
    let truncated = text;
    while (Buffer.byteLength(truncated, "utf8") > MAX_CONTENT_BYTES && truncated.length > 0) {
        truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    return truncated.trimEnd() + (truncated.length < text.length ? "…" : "");
}
function formatDueDate(dueDate) {
    if (!dueDate)
        return "Not set";
    const date = dueDate instanceof Date ? dueDate : new Date(dueDate);
    if (Number.isNaN(date.getTime()))
        return "Not set";
    return date.toISOString().slice(0, 10);
}
export async function buildTaskEmbeddingContent(taskId) {
    const taskResult = await pool.query(`SELECT title, description, status, priority, due_date FROM tasks WHERE id = $1`, [taskId]);
    if (taskResult.rows.length === 0)
        return null;
    const task = taskResult.rows[0];
    const commentsResult = await pool.query(`SELECT content FROM task_comments
     WHERE task_id = $1
     ORDER BY created_at DESC
     LIMIT $2`, [taskId, MAX_RECENT_COMMENTS]);
    const commentLines = commentsResult.rows
        .reverse()
        .map((c) => `- ${truncate(c.content, MAX_COMMENT_CHARS)}`);
    const parts = [
        `Title: ${task.title}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Due: ${formatDueDate(task.due_date)}`,
    ];
    if (task.description) {
        parts.push(`Description: ${truncate(String(task.description), 400)}`);
    }
    if (commentLines.length) {
        parts.push("Recent updates:", ...commentLines);
    }
    return capContent(parts.join("\n"));
}
function vectorLiteral(embedding) {
    return `[${embedding.join(",")}]`;
}
export async function upsertTaskEmbedding(taskId) {
    try {
        const content = await buildTaskEmbeddingContent(taskId);
        if (!content) {
            await pool.query(`DELETE FROM task_embeddings WHERE task_id = $1`, [taskId]);
            return;
        }
        const ai = getAIProvider();
        const [embedding] = await ai.embed([content]);
        if (!embedding?.length) {
            console.warn("[RAG] Empty embedding for task", { taskId });
            return;
        }
        await pool.query(`INSERT INTO task_embeddings (task_id, content, embedding, updated_at)
       VALUES ($1, $2, $3::vector, now())
       ON CONFLICT (task_id) DO UPDATE
       SET content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           updated_at = now()`, [taskId, content, vectorLiteral(embedding)]);
        console.log("[RAG] Upserted task embedding", { taskId, contentBytes: Buffer.byteLength(content) });
    }
    catch (error) {
        console.error("[RAG] upsertTaskEmbedding failed", { taskId, error });
    }
}
/** Fire-and-forget re-index; never blocks the HTTP response */
export function scheduleTaskEmbedding(taskId) {
    void upsertTaskEmbedding(taskId);
}
export async function retrieveAssignedTasks(profileId, queryText, topK = TOP_K) {
    const ai = getAIProvider();
    const [queryEmbedding] = await ai.embed([queryText]);
    if (!queryEmbedding?.length)
        return [];
    const result = await pool.query(`SELECT te.task_id, te.content, t.title, t.status, t.priority, t.due_date,
            (te.embedding <=> $1::vector) AS distance
     FROM task_embeddings te
     JOIN tasks t ON t.id = te.task_id
     JOIN task_assignees ta ON ta.task_id = te.task_id AND ta.profile_id = $2
     ORDER BY te.embedding <=> $1::vector
     LIMIT $3`, [vectorLiteral(queryEmbedding), profileId, topK]);
    return result.rows;
}
export async function backfillAllTaskEmbeddings() {
    const tasks = await pool.query(`SELECT id FROM tasks`);
    let ok = 0;
    let failed = 0;
    for (const row of tasks.rows) {
        try {
            await upsertTaskEmbedding(row.id);
            ok += 1;
        }
        catch {
            failed += 1;
        }
    }
    return { total: tasks.rows.length, ok, failed };
}
