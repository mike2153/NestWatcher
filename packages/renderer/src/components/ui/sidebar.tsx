"use client"

import * as React from "react"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

const SIDEBAR_WIDTH = "13rem"
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
          className={cn("group/sidebar-wrapper flex h-svh w-full max-w-full overflow-hidden", className)}
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
        <SheetContent side="left" className="bg-sidebar text-sidebar-foreground w-[var(--sidebar-width)] p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="bg-sidebar flex h-full w-full flex-col overflow-hidden">
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
        "flex h-svh flex-col overflow-hidden text-sidebar-foreground w-[var(--sidebar-width)] border-r",
        className
      )}
      style={{ backgroundColor: 'var(--sidebar)' }}
      {...props}
    >
      {children}
    </aside>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("flex h-svh flex-1 flex-col min-w-0 overflow-hidden bg-background", className)} {...props} />
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("flex items-center h-12 px-3", className)} {...props} />
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("flex-1 min-h-0 overflow-y-auto p-2", className)} {...props} />
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

function SidebarMenuButton({
  className,
  isActive,
  children,
  ...props
}: React.ComponentProps<"button"> & { isActive?: boolean }) {
  return (
    <button
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(
        "flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export {
  useSidebar,
  SidebarProvider,
  Sidebar,
  SidebarInset,
  SidebarHeader,
  SidebarFooter,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
}
