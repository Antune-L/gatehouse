import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        // NOTE: identifiers (hosts, users, table names) are not prose — macOS
        // would otherwise offer to "correct" them while typing.
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-input-bg px-3 py-2 text-[13px] text-foreground transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
