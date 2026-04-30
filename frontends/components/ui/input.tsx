import * as React from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional decorative icon rendered inside the left edge of the input. */
  icon?: React.ReactNode;
  /** Optional element rendered inside the right edge (e.g. password toggle). */
  endSlot?: React.ReactNode;
}

const BASE =
  "flex h-11 w-full rounded-lg border border-[#E5EBF2] bg-white text-sm text-[#1F2937] " +
  "placeholder:text-[#A0AEC0] transition-colors " +
  "focus-visible:outline-none focus-visible:border-[#2196FA] focus-visible:ring-4 focus-visible:ring-[#5BAEFF]/15 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, endSlot, ...props }, ref) => {
    if (!icon && !endSlot) {
      return <input type={type} ref={ref} className={cn(BASE, "px-4", className)} {...props} />;
    }
    return (
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#A0AEC0]">
            {icon}
          </span>
        )}
        <input
          type={type}
          ref={ref}
          className={cn(BASE, icon ? "pl-11" : "pl-4", endSlot ? "pr-11" : "pr-4", className)}
          {...props}
        />
        {endSlot && (
          <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center text-[#A0AEC0]">
            {endSlot}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

export { Input };
