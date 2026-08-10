import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  var __agentForgePool: Pool | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required by the workflow functions");
  }

  const isLocal = /localhost|127\.0\.0\.1|@postgres(?::|\/)/.test(connectionString);
  return new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

export const pool = globalThis.__agentForgePool ?? createPool();
if (process.env.NODE_ENV !== "production") globalThis.__agentForgePool = pool;

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await client.query<T>(sql, values);
  if (result.rowCount !== 1) throw new Error("Expected exactly one database row");
  return result.rows[0];
}

export async function maybeOne<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await client.query<T>(sql, values);
  return result.rows[0] ?? null;
}
