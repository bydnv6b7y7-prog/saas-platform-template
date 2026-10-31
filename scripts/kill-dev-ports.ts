export {};

const DEV_PORTS = [3000, 3001] as const;

const pids = new Set<number>();

for (const port of DEV_PORTS) {
  const lookup = Bun.spawn(
    ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(lookup.stdout).text(),
    new Response(lookup.stderr).text(),
    lookup.exited,
  ]);

  // lsof exits with 1 when no matching listener exists.
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(
      `Could not inspect port ${port}: ${stderr.trim() || `lsof exited ${exitCode}`}`,
    );
  }

  for (const value of stdout.trim().split(/\s+/)) {
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
}

if (pids.size === 0) {
  console.log(`Development ports ${DEV_PORTS.join(" and ")} are already free.`);
  process.exit(0);
}

const failures: string[] = [];
for (const pid of pids) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      failures.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Could not stop every development listener (${failures.join(", ")})`);
}

console.log(`Force-stopped development listener PID(s): ${[...pids].join(", ")}.`);
