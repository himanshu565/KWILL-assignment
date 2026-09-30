import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const globalForPg = globalThis as unknown as { encorePool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.encorePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForPg.encorePool = new Pool({
      connectionString,
      max: 10,
    });
  }
  return globalForPg.encorePool;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function query<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return client.query<T>(text, values);
}
