const LOG_TAIL_LENGTH = 4000;

type MigrationHealthInput = {
  status: "complete" | "failed";
  buildSha: string;
  log: string;
};

export function createMigrationHealthPayload({
  status,
  buildSha,
  log,
}: MigrationHealthInput) {
  return {
    status,
    sha: status === "complete" ? buildSha : "",
    buildSha,
    log: log.slice(-LOG_TAIL_LENGTH),
  };
}
