import { cn } from "#/lib/utils.ts"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

function Spinner({ className, role = "status", "aria-label": ariaLabel = "Loading" }: React.ComponentProps<"svg">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      role={role}
      aria-label={ariaLabel}
      className={cn("size-4 animate-spin", className)}
    />
  )
}

export { Spinner }
