import type { ReactNode } from "react";

export function DataUnavailable({
  title = "Live data not configured",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>
        {children ??
          "The live adapter is not wired yet. Preview values are intentionally hidden so they are never mistaken for live data."}
      </p>
    </div>
  );
}
