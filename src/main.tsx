import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./App";
import { Toasts } from "./components/Toasts";
import "./theme/global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  },
});

async function start(): Promise<void> {
  // `VITE_USE_MOCKS=true pnpm dev` serves the whole UI from the captured fixtures. The mock
  // handlers answer for the whole API base and refuse anything else, so no click can reach a
  // real house by accident.
  if (import.meta.env.VITE_USE_MOCKS === "true") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledFrame: "warn", quiet: false });
  }

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toasts />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
