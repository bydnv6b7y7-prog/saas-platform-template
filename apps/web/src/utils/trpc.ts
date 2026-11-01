import type { AppRouter } from "@northwind/product/router";
import { createTRPCContext } from "@trpc/tanstack-react-query";

/** @public useTRPCClient: imperative calls (e.g. a multi-step upload) for product code. */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
