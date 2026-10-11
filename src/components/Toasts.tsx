import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "@/lib/toast";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  wrap: {
    position: "fixed",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: "calc(64px + env(safe-area-inset-bottom))",
    display: "flex",
    flexDirection: "column",
    gap: tokens.space2,
    zIndex: 100,
    width: "min(92vw, 420px)",
  },
  toast: {
    borderRadius: tokens.radiusSm,
    borderStyle: "solid",
    borderWidth: 1,
    padding: tokens.space3,
    fontSize: tokens.fontMd,
    boxShadow: tokens.shadow,
    backgroundColor: tokens.surfaceRaised,
    color: tokens.text,
  },
  ok: { borderColor: tokens.ok },
  bad: { borderColor: tokens.bad },
  info: { borderColor: tokens.border },
});

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
    <div {...stylex.props(styles.wrap)}>
      {items.map((item) => (
        <div
          key={item.id}
          {...stylex.props(
            styles.toast,
            item.kind === "ok" ? styles.ok : item.kind === "bad" ? styles.bad : styles.info,
          )}
          onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
