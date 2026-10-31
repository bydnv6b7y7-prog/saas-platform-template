import { z } from "zod";

export const ADMIN_USER_NAME_MAX_LENGTH = 128;
export const ADMIN_USER_EMAIL_MAX_LENGTH = 254;
export const ADMIN_USER_PASSWORD_MIN_LENGTH = 8;
export const ADMIN_USER_PASSWORD_MAX_LENGTH = 128;

export const adminUserRoleSchema = z.enum(["user", "admin"]);

export function normalizeAdminUserEmail(email: string) {
  return email.trim().toLowerCase();
}

export const adminUserDetailsSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .max(ADMIN_USER_NAME_MAX_LENGTH),
  email: z
    .string()
    .transform(normalizeAdminUserEmail)
    .pipe(
      z.email("Enter a valid email address.").max(ADMIN_USER_EMAIL_MAX_LENGTH),
    ),
  role: adminUserRoleSchema,
  emailVerified: z.boolean(),
});

export const adminCreateUserSchema = adminUserDetailsSchema.extend({
  password: z
    .string()
    .min(
      ADMIN_USER_PASSWORD_MIN_LENGTH,
      "Use at least 8 characters for the password.",
    )
    .max(
      ADMIN_USER_PASSWORD_MAX_LENGTH,
      "Use at most 128 characters for the password.",
    ),
});

export const adminUpdateUserSchema = adminUserDetailsSchema
  .partial()
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    "No changes to save.",
  );

export type AdminUserDetails = z.infer<typeof adminUserDetailsSchema>;
