import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "@/lib/toast";

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToasts((toast) => {
      setItems((current) => [...current.slice(-3), toast]);
      setTimeout(() => setItems((current) => current.filter((item) => item.id !== toast.id)), 5000);
    });
    return unsubscribe;
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "calc(72px + env(safe-area-inset-bottom))",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        zIndex: 100,
        width: "min(92vw, 420px)",
      }}
    >
      {items.map((item) => {
        const bg =
          item.kind === "ok"
            ? "var(--md-sys-color-success-container)"
            : item.kind === "bad"
              ? "var(--md-sys-color-error-container)"
              : "var(--md-sys-color-surface-container-high)";

        const color =
          item.kind === "ok"
            ? "var(--md-sys-color-on-success-container)"
            : item.kind === "bad"
              ? "var(--md-sys-color-on-error-container)"
              : "var(--md-sys-color-on-surface)";

        return (
          <div
            key={item.id}
            onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
            style={{
              borderRadius: "8px",
              padding: "12px 16px",
              fontSize: "14px",
              backgroundColor: bg,
              color,
              boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
              cursor: "pointer",
            }}
          >
            {item.message}
          </div>
        );
      })}
    </div>
  );
}
