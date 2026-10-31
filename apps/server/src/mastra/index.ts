import { Mastra } from "@mastra/core";
import {
  MastraStorageExporter,
  Observability,
} from "@mastra/observability";

import { assistantAgents } from "../product";
import { mastraStorage } from "./storage";

const mastraObservability = new Observability({
  configs: {
    default: {
      serviceName: "northwind-mastra",
      exporters: [
        new MastraStorageExporter({
          strategy: "batch-with-updates",
          maxBatchWaitMs: 1_000,
        }),
      ],
      // Correlate traces to safe HTTP request IDs without persisting account IDs.
      requestContextKeys: ["requestId"],
      serializationOptions: {
        maxStringLength: 8_000,
        maxArrayLength: 100,
        maxDepth: 8,
      },
    },
  },
});

export const mastra = new Mastra({
  agents: assistantAgents,
  storage: mastraStorage,
  observability: mastraObservability,
});
