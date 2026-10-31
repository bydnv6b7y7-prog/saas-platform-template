import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { z } from "zod";

import { getRequestId } from "../logging";

export const assistantRequestContextSchema = z.object({
  requestStartedAt: z.string().datetime(),
  requestId: z.string().min(1).max(128).optional(),
});

export type AssistantRequestContextValues = z.infer<
  typeof assistantRequestContextSchema
>;
export type AssistantRequestContext =
  RequestContext<AssistantRequestContextValues>;

export function assistantRequestStartedAt(
  requestContext: AssistantRequestContext,
): Date {
  return new Date(requestContext.get("requestStartedAt"));
}

export function createUserRequestContext(
  userId: string,
  now = new Date(),
): AssistantRequestContext {
  const requestContext = new RequestContext<AssistantRequestContextValues>();
  requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, userId);
  requestContext.set("requestStartedAt", now.toISOString());
  const requestId = getRequestId();
  if (requestId) requestContext.set("requestId", requestId);
  return requestContext;
}
