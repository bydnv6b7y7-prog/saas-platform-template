import z from "zod";

const emailSchema = z.email("Enter a valid email address");
const passwordSchema = z.string().min(8, "Password must be at least 8 characters");

export const signInFormValidators = {
  onChange: z.object({
    email: emailSchema,
    password: passwordSchema,
  }),
};

export const signUpFormValidators = {
  onChange: z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters"),
    email: emailSchema,
    password: passwordSchema,
  }),
};
