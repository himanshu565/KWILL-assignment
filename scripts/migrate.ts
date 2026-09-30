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
  const schemaPath = path.resolve(process.cwd(), "sql/001_schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(sql);
    console.log("Applied sql/001_schema.sql");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
