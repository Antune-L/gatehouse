import type { CellValue, SqlType } from "@/lib/types";
import { cn } from "@/lib/utils";

export function CellContent({
  value,
  type,
  isFk,
}: {
  value: CellValue;
  type: SqlType;
  isFk?: boolean;
}) {
  const isTemporal = type === "timestamp" || type === "date";
  if (value === null) {
    return (
      <span className="italic text-muted-foreground/50 select-none">NULL</span>
    );
  }
  if (value === "") {
    return (
      <span className="rounded bg-panel-2 px-1 text-[10px] text-muted-foreground/60 select-none">
        empty
      </span>
    );
  }
  if (typeof value === "boolean") {
    return (
      <span
        className={cn(
          "font-mono text-[12px]",
          value ? "text-success" : "text-destructive/80"
        )}
      >
        {value ? "true" : "false"}
      </span>
    );
  }
  if (typeof value === "number") {
    return (
      <span
        className={cn(
          "font-mono tabular-nums",
          isFk && "text-info underline decoration-dotted underline-offset-2"
        )}
      >
        {value}
      </span>
    );
  }
  return (
    <span
      className={cn(
        isFk && "text-info underline decoration-dotted underline-offset-2",
        isTemporal && "font-mono tabular-nums text-foreground/80"
      )}
    >
      {value}
    </span>
  );
}

export function isLargeValue(value: CellValue): boolean {
  return typeof value === "string" && (value.length > 64 || value.includes("\n"));
}
