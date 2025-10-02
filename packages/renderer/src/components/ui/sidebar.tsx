"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { PanelLeftIcon } from "lucide-react"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

const SIDEBAR_WIDTH = "12rem"
const SIDEBAR_WIDTH_ICON = "3rem"

type SidebarContextProps = {
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.")
  return context
}

function SidebarProvider({ className, style, children, ...props }: React.ComponentProps<"div">) {
  const isMobile = useIsMobile()
  const [open, setOpen] = React.useState(true)
  const [openMobile, setOpenMobile] = React.useState(false)
  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((v) => !v)
    else setOpen((v) => !v)
  }, [isMobile])

  const sidebarVars: Record<string, string> = {
    "--sidebar-width": SIDEBAR_WIDTH,
    "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
  }

  return (
    <SidebarContext.Provider value={{ open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar }}>
      <div
        data-collapsible={open ? "full" : "icon"}
        className={cn("group/sidebar-wrapper flex min-h-svh w-full max-w-full overflow-x-hidden", className)}
        style={{
          ...(style as React.CSSProperties),
          ...sidebarVars,
        }}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({ className, children, ...props }: React.ComponentProps<"div">) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="left" className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="bg-sidebar flex h-full w-full flex-col">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "text-sidebar-foreground w-(--sidebar-width) border-r bg-sidebar",
        className
      )}
      {...props}
    >
      {children}
    </aside>
  )
}

function SidebarTrigger({ className, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button variant="outline" size="icon" className={cn("shrink-0", className)} onClick={toggleSidebar} {...props}>
      <PanelLeftIcon className="size-5" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("flex min-h-svh flex-1 flex-col min-w-0 overflow-x-hidden", className)} {...props} />
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("flex items-center h-12 px-3", className)} {...props} />
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("flex-1 p-2", className)} {...props} />
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("p-2", className)} {...props} />
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("flex flex-col gap-1", className)} {...props} />
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("", className)} {...props} />
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md pl-6 pr-2 text-left text-base font-medium outline-hidden ring-sidebar-ring transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>span:last-child]:pl-3 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      size: { default: "h-9", sm: "h-8", lg: "h-10" },
      variant: { default: "", outline: "bg-background shadow-[0_0_0_1px_var(--sidebar-border)]" },
    },
    defaultVariants: { size: "default", variant: "default" },
  }
)

function SidebarMenuButton({ className, size, variant, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof sidebarMenuButtonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="sidebar-menu-button" className={cn(sidebarMenuButtonVariants({ size, variant }), className)} {...props} />
}

export {
  useSidebar,
  SidebarProvider,
  Sidebar,
  SidebarTrigger,
  SidebarInset,
  SidebarHeader,
  SidebarFooter,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
}
