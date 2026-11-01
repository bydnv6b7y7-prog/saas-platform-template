import type { AppRouter } from "@northwind/product/router";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "sonner";

import Loader from "@/components/loader";
import { RouteErrorState, RouteNotFoundState } from "@/components/route-state";
import { getApiBaseURL } from "@/lib/api-url";
import { routeTree } from "@/routeTree.gen";
import { TRPCProvider } from "@/utils/trpc";

function getCspNonce(): string {
  if (typeof document !== "undefined") {
    const nonce = document
      .querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
      ?.getAttribute("content");
    if (nonce) return nonce;
  }

  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
    queryCache: new QueryCache({
      onError: (_error, query) => {
        if (typeof window === "undefined" || query.state.data === undefined) return;
        toast.error("Could not refresh the latest data.", {
          action: {
            label: "Retry",
            onClick: () => {
              void query.invalidate();
            },
          },
        });
      },
    }),
  });
}

export function getRouter() {
  const queryClient = createQueryClient();
  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${getApiBaseURL()}/trpc`,
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: "include",
          });
        },
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient,
  });
  const nonce = getCspNonce();

  const router = createTanStackRouter({
    routeTree,
    context: { nonce, queryClient, trpc },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: Loader,
    defaultErrorComponent: ({ reset }) => <RouteErrorState reset={reset} />,
    defaultNotFoundComponent: RouteNotFoundState,
    ssr: { nonce },
    Wrap: ({ children }) => (
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
