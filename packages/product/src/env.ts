import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

/** Product-only variables. Platform variables live in @northwind/env/server. */
export const productEnv = createEnv({
  server: {},
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
