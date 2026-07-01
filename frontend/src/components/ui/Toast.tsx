import { createContext, useCallback, useContext, useMemo } from "react";
import { CheckCircle2, CircleX, X } from "lucide-react";
import { Toaster, toast as sonnerToast } from "sonner";

type ToastTone = "success" | "error";

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const show = useCallback((message: string, tone: ToastTone) => {
    sonnerToast.custom((id) => (
      <div className={`toast toast-${tone}`}>
        {tone === "error" ? <CircleX size={16} /> : <CheckCircle2 size={16} />}
        <span>{message}</span>
        <button aria-label="Dismiss notification" onClick={() => sonnerToast.dismiss(id)}><X size={14} /></button>
      </div>
    ), { duration: 4000 });
  }, []);
  const success = useCallback((message: string) => show(message, "success"), [show]);
  const error = useCallback((message: string) => show(message, "error"), [show]);

  const value = useMemo(() => ({ success, error }), [error, success]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster className="toast-stack" position="top-right" offset={24} visibleToasts={5} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
