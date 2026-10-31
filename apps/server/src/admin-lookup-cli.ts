import { closeDb, db, sql } from "@northwind/db";
import { user } from "@northwind/db/schema/auth";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  throw new Error("Usage: bun run admin:lookup user@example.com");
}

try {
  const [account] = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);

  if (!account) {
    throw new Error(`No user found for ${email}`);
  }

  console.log(JSON.stringify(account));
} finally {
  await closeDb();
}
