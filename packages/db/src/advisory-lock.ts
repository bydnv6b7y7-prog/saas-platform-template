type AdvisoryLockClient = {
  query: (
    text: string,
    values: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (error?: Error | boolean) => void;
};

type AdvisoryLock = {
  release: () => Promise<void>;
};

/**
 * Owns the complete lifecycle of the dedicated PostgreSQL session used by a
 * session-level advisory lock. Broken sessions are destroyed instead of being
 * returned to the pool with an unknown lock state.
 */
export async function acquireAdvisoryLockConnection(
  connect: () => Promise<AdvisoryLockClient>,
  key: number,
): Promise<AdvisoryLock | null> {
  const client = await connect();
  let connectionReleased = false;
  const releaseConnection = (error?: unknown) => {
    if (connectionReleased) return;
    connectionReleased = true;
    client.release(
      error === undefined ? undefined : error instanceof Error ? error : true,
    );
  };

  try {
    const result = await client.query("SELECT pg_try_advisory_lock($1)", [key]);
    if (result.rows[0]?.pg_try_advisory_lock !== true) {
      releaseConnection();
      return null;
    }
  } catch (error) {
    releaseConnection(error);
    throw error;
  }

  let lockReleased = false;
  return {
    release: async () => {
      if (lockReleased) return;
      lockReleased = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
        releaseConnection();
      } catch (error) {
        releaseConnection(error);
        throw error;
      }
    },
  };
}
