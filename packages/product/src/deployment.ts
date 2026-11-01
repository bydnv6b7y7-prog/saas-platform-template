type Values = Record<string, string | undefined>;

/**
 * Product additions to the Dokploy topology (scripts/dokploy-provision.ts). The platform provisions
 * PostgreSQL, the migration job, the API and the web app; a product adds variables, a shared volume
 * and at most one background worker here.
 */
export type ProductDeployment = {
  /** Variables for every server-image process (migration, API, worker). */
  serverEnv(production: Values, local: Values): string[];
  /** Variables only the API process receives, e.g. external product credentials. */
  apiEnv(production: Values, local: Values): string[];
  /** Volume shared by the API and the worker, or null. */
  volume: { name: string; mountPath: string } | null;
  /** Long-running worker on the server image (Dokploy app `<project>-<name>`), or null. */
  worker: { name: string; command: string; env: string[] } | null;
};

export const productDeployment: ProductDeployment = {
  serverEnv: () => [],
  apiEnv: () => [],
  volume: null,
  worker: null,
};
