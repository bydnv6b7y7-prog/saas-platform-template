import { z } from "zod";

import {
  POSTHOG_BROWSER_PROXY_HOST,
  posthogProjectTokenSchema,
} from "./posthog";

/** Browser-safe configuration shared by products built from this stack. */
export const platformWebSchema = {
  VITE_SERVER_URL: z.url(),
  VITE_WEB_URL: z.url().default("http://localhost:3001"),
  VITE_ENABLE_INDEXING: z.enum(["true", "false"]).default("false"),
  VITE_POSTHOG_PROJECT_TOKEN: posthogProjectTokenSchema.optional(),
  VITE_POSTHOG_HOST: z.url().default(POSTHOG_BROWSER_PROXY_HOST),
};
