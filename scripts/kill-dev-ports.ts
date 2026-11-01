export {};

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEV_PORTS = [Number(process.env.PORT) || 3000, 3001] as const;

/** Only this checkout's own dev servers: a listener whose working directory is outside it is left alone. */
function cwdOf(pid: number): string | null {
  const result = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString().split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
}
const skipped: string[] = [];

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
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const cwd = cwdOf(pid);
    if (cwd === root || cwd?.startsWith(`${root}/`)) pids.add(pid);
    else skipped.push(`port ${port} (PID ${pid}, ${cwd ?? "unknown directory"})`);
  }
}

if (skipped.length) console.log(`Left alone, not started from this checkout: ${skipped.join("; ")}. Set PORT to use another API port.`);
if (pids.size === 0) {
  console.log(`No development server from this checkout is listening on ${DEV_PORTS.join(" or ")}.`);
  process.exit(0);
}

const failures: string[] = [];
for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      failures.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Could not stop every development listener (${failures.join(", ")})`);
}

console.log(`Stopped this checkout's development server PID(s): ${[...pids].join(", ")}.`);
