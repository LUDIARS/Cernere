import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import "./global.css";
import "./composite-theme.css";

// Keep the device palette through embedded registration/recovery navigation too.
if (window.self !== window.top || window.location.pathname.startsWith("/composite/")) {
  document.documentElement.dataset.compositeTheme = "device";
}
if (window.self !== window.top) document.documentElement.dataset.compositeEmbedded = "true";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
