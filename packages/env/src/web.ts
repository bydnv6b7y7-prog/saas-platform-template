import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { platformWebSchema } from "./platform-web-schema";

type WebImportMeta = ImportMeta & {
  readonly env: Record<string, string | boolean | undefined>;
};

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    ...platformWebSchema,
    VITE_BRAND_NAME: z.string().min(1).default("Northwind"),
  },
  runtimeEnv: (import.meta as WebImportMeta).env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
