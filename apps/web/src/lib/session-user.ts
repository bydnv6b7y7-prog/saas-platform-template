import { z } from "zod";

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish().transform((value) => value ?? "Account"),
  email: z.string(),
});

export type AppUser = z.infer<typeof sessionUserSchema>;
