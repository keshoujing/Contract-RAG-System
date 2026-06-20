import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ToastProvider } from "./components/ui/Toast";
import { ContractDetailPage } from "./features/contracts/ContractDetailPage";
import { ConflictPage } from "./features/conflicts/ConflictPage";
import { LedgerPage } from "./features/ledger/LedgerPage";
import { ProcessingPage } from "./features/processing/ProcessingPage";
import { QuestionAnswerPage } from "./features/qa/QuestionAnswerPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { UploadPage } from "./features/upload/UploadPage";
import "./styles.css";

interface AppProps {
  initialPath?: string;
}

export default function App({ initialPath }: AppProps) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } }));
  const Router = initialPath ? MemoryRouter : BrowserRouter;
  const routerProps = {
    ...(initialPath ? { initialEntries: [initialPath] } : {}),
    future: { v7_relativeSplatPath: true, v7_startTransition: true }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <Router {...routerProps}>
        <ToastProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/processing" replace />} />
              <Route path="/ledger" element={<LedgerPage />} />
              <Route path="/qa" element={<QuestionAnswerPage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/processing" element={<ProcessingPage />} />
              <Route path="/conflicts/:id" element={<ConflictPage />} />
              <Route path="/contracts/:id" element={<ContractDetailPage />} />
            </Routes>
          </AppShell>
        </ToastProvider>
      </Router>
    </QueryClientProvider>
  );
}
