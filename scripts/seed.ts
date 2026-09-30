import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";

function loadEnv(): void {
  for (const file of [".env", ".env.local"]) {
    try {
      loadEnvFile(path.resolve(process.cwd(), file));
    } catch {
      /* file may be absent */
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const clean = process.argv.includes("--clean") || process.argv.includes("-c");
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
  });

  try {
    if (clean) {
      await pool.query("TRUNCATE TABLE webhook_events, holds, orders CASCADE;");
      console.log("Cleaned existing webhook_events, holds, and orders.");
    }
    const seedPath = path.resolve(process.cwd(), "sql/002_seed.sql");
    const sql = fs.readFileSync(seedPath, "utf8");
    await pool.query(sql);
    console.log("Seeded Anoushka Shankar (Lisbon) and Indie Devs (Berlin)");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
