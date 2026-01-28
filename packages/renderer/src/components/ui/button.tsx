import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-md text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] relative overflow-hidden transform-gpu transition-transform transition-shadow duration-200",
  {
    variants: {
      variant: {
        // Primary action button style (fixed blue across themes)
        default: "bg-[var(--blue-button)] text-[var(--blue-button-foreground)] shadow-sm hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-sm",

        // Cancel / destructive button style (fixed red across themes)
        destructive:
          "bg-[var(--red-button)] text-[var(--red-button-foreground)] shadow-sm hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-sm",

        // Keep other variants available for layout/semantics; they also get the same raise behavior.
        outline:
          "border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-sm hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-sm",
        secondary:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)] shadow-sm hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-sm",
        ghost:
          "text-[var(--foreground)] hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:shadow-sm",
        link: "text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md gap-2 px-3 py-1.5 text-sm",
        lg: "h-11 rounded-md px-6 py-3",
        icon: "size-10 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

