import pg from "pg";
import dotenv from "dotenv";
dotenv.config();
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set in environment variables");
}
const cleanUrl = databaseUrl.split("?")[0];
export const pool = new Pool({
    connectionString: cleanUrl,
    ssl: {
        rejectUnauthorized: false,
    },
});
pool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client", err);
});
