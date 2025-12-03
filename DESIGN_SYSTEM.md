# NestWatcher Design System

Complete design system extraction from the NestWatcher Electron app for reuse in other applications.

---

## Table of Contents

1. [Dependencies](#1-dependencies)
2. [File Structure](#2-file-structure)
3. [Color System](#3-color-system)
4. [Typography](#4-typography)
5. [Icons](#5-icons)
6. [Components](#6-components)
7. [Utility Functions](#7-utility-functions)
8. [Theme Support](#8-theme-support)
9. [Responsive Design](#9-responsive-design)
10. [CSS Files](#10-css-files)
11. [Tailwind Configuration](#11-tailwind-configuration)

---

## 1. Dependencies

### package.json

```json
{
  "dependencies": {
    "@fontsource-variable/geist": "^5.2.8",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "lucide-react": "^0.462.0",
    "motion": "^12.23.22",
    "tailwind-merge": "^2.3.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-separator": "^1.1.7",
    "@radix-ui/react-slot": "^1.2.3",
    "@tailwindcss/postcss": "^4.1.13",
    "tailwindcss": "^4.1.13",
    "autoprefixer": "^10.4.18",
    "postcss": "^8.4.38"
  }
}
```

---

## 2. File Structure

```
src/
├── components/
│   └── ui/
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── context-menu.tsx
│       ├── dropdown-menu.tsx
│       ├── glowing-effect.tsx
│       ├── separator.tsx
│       ├── sheet.tsx
│       ├── sidebar.tsx
│       └── table.tsx
├── hooks/
│   └── use-mobile.ts
├── utils/
│   └── cn.ts
├── lib/
│   └── utils.ts          (re-exports cn)
├── styles/
│   └── theme.css
├── index.css
└── main.tsx
```

---

## 3. Color System

### CSS Variables (Light Theme - Default)

```css
:root {
  /* Core Colors */
  --background: linear-gradient(135deg, theme('colors.neutral.200') 0%, theme('colors.neutral.100') 50%, theme('colors.neutral.100') 100%);
  --background-body: linear-gradient(to right, #feffff 0%, #feffff 100%);
  --foreground: theme('colors.zinc.900');           /* #18181b - Main text */
  --card: linear-gradient(to right, #fffffff3 0%, #ffffffef 100%);
  --card-foreground: theme('colors.zinc.900');
  --primary: #1647e0;                               /* Vibrant indigo */
  --destructive: theme('colors.rose.600');          /* #e11d48 */
  --muted: theme('colors.slate.100');               /* #f1f5f9 */
  --muted-foreground: theme('colors.slate.100');
  --border: theme('colors.stone.500');              /* #78716c */

  /* Status Indicators */
  --status-success-bg: theme('colors.emerald.100'); /* #d1fae5 */
  --status-success-text: theme('colors.emerald.700'); /* #047857 */
  --status-warning-bg: theme('colors.amber.100');   /* #fef3c7 */
  --status-warning-text: theme('colors.amber.700'); /* #b45309 */
  --status-error-bg: theme('colors.rose.100');      /* #ffe4e6 */
  --status-error-text: theme('colors.rose.700');    /* #be123c */

  /* Table Colors */
  --table-bg: #feffff;
  --table-header-bg: #e2e2e2;
  --table-text: theme('colors.gray.900');           /* #111827 */
  --table-border: theme('colors.neutral.100');
  --table-row-border: theme('colors.neutral.300');
  --table-hover-bg: #e9e9e9;
  --table-selected-bg: #e9e9e9;

  /* Sidebar Colors */
  --sidebar: #f7f6f6;
  --sidebar-foreground: #404040;
  --sidebar-accent: #eaeaeac5;
  --sidebar-border: theme('colors.slate.600');

  /* Input Styling */
  --input-border: theme('colors.gray.700');
  --input-border-width: 1.5px;
  --input-bg: #f3f4f6;

  /* Page Title Gradient */
  --page-title-gradient: linear-gradient(135deg, theme('colors.stone.900') 0%, theme('colors.stone.700') 50%, theme('colors.stone.900') 100%);

  /* Design Tokens */
  --radius: 0.75rem;
  --shadow-sm: 0 1px 2px 0 rgba(0,0,0,0.05);
  --shadow-base: 0 1px 3px 0 rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.10);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.10);
  --shadow-xl: 0 20px 25px -5px rgba(0,0,0,0.10), 0 8px 10px -6px rgba(0,0,0,0.10);
  --transition-fast: 150ms ease;
  --transition-normal: 200ms ease;
  --transition-slow: 300ms ease;

  /* Alpha Variants */
  --muted-a50: color-mix(in srgb, theme('colors.cyan.900') 50%, transparent);
  --primary-a10: color-mix(in srgb, theme('colors.indigo.500') 10%, transparent);
  --primary-a15: color-mix(in srgb, theme('colors.indigo.500') 15%, transparent);
  --primary-a20: color-mix(in srgb, theme('colors.indigo.500') 20%, transparent);
  --primary-a30: color-mix(in srgb, theme('colors.indigo.500') 30%, transparent);
  --border-a06: color-mix(in srgb, theme('colors.slate.200') 6%, transparent);
  --border-a08: color-mix(in srgb, theme('colors.slate.200') 8%, transparent);
  --border-a10: color-mix(in srgb, theme('colors.slate.200') 10%, transparent);
  --border-a30: color-mix(in srgb, theme('colors.slate.200') 30%, transparent);
}
```

### Dark Theme

```css
.dark {
  --background: theme('colors.slate.900');
  --foreground: theme('colors.gray.200');
  --card: theme('colors.gray.800');
  --card-foreground: theme('colors.gray.200');
  --muted: theme('colors.slate.700');
  --muted-foreground: theme('colors.slate.400');
  --accent: theme('colors.slate.700');
  --border: theme('colors.slate.700');
  --table-bg: theme('colors.gray.800');
  --table-header-bg: theme('colors.slate.700');
  --table-text: theme('colors.gray.200');
  --table-hover-bg: color-mix(in srgb, theme('colors.slate.200') 10%, transparent);
  --table-selected-bg: color-mix(in srgb, theme('colors.indigo.400') 20%, transparent);
  --sidebar: theme('colors.slate.900');
  --sidebar-foreground: theme('colors.gray.200');
  --sidebar-accent: theme('colors.gray.800');
  --sidebar-border: theme('colors.slate.700');
}
```

### Modern Theme

```css
.modern {
  --background: theme('colors.blue.50');
  --foreground: theme('colors.slate.900');
  --card: theme('colors.white');
  --card-foreground: theme('colors.slate.900');
  --primary: theme('colors.sky.500');
  --accent: theme('colors.blue.400');
  --muted: theme('colors.slate.50');
  --muted-foreground: theme('colors.slate.500');
  --border: theme('colors.blue.200');
  --table-bg: theme('colors.white');
  --table-header-bg: theme('colors.slate.50');
  --table-text: theme('colors.slate.900');
  --table-hover-bg: color-mix(in srgb, theme('colors.slate.900') 6%, transparent);
  --table-selected-bg: color-mix(in srgb, theme('colors.sky.500') 12%, transparent);
  --sidebar: theme('colors.blue.50');
  --sidebar-foreground: theme('colors.slate.900');
  --sidebar-accent: theme('colors.blue.100');
  --sidebar-border: theme('colors.blue.200');
}
```

---

## 4. Typography

### Font Stack

```css
/* Primary Font */
font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

/* Monospace Font */
font-family: JetBrains Mono, Fira Code, Consolas, monospace;
```

### Font Import

```typescript
// In your main entry file (main.tsx or App.tsx)
import '@fontsource-variable/geist';
```

### Font Sizes

| Class | Size | Line Height |
|-------|------|-------------|
| `text-xs` | var(--text-xs) | tight |
| `text-sm` | var(--text-sm) | normal |
| `text-base` | var(--text-base) | normal |
| `text-lg` | var(--text-lg) | normal |
| `text-xl` | var(--text-xl) | snug |
| `text-2xl` | var(--text-2xl) | snug |
| `text-3xl` | var(--text-3xl) | tight |
| `text-4xl` | var(--text-4xl) | tight |

---

## 5. Icons

### Library: Lucide React

```bash
npm install lucide-react
```

### Common Icons Used

```tsx
import {
  LayoutDashboard,  // Dashboard
  Router,           // Router/Routing
  History,          // History
  Settings,         // Settings
  Layers,           // Layers/Allocated
  BellRing,         // Alarms/Notifications
  Gauge,            // Telemetry/Metrics
  ListCheck,        // Jobs/Tasks
  AlignVerticalJustifyEnd,  // Custom alignment
  MessageSquare,    // Messages
  ShoppingCart,     // Ordering/Cart
  UserRound,        // User/Login
  LogOut,           // Logout
} from 'lucide-react';
```

### Icon Sizing

```css
/* Default icon size in buttons/nav */
[&>svg]:size-4    /* 16px */
[&_svg]:shrink-0  /* Prevent shrinking */
```

---

## 6. Components

### Button Component

```tsx
// components/ui/button.tsx
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive relative overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 shadow-md",
        destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 shadow-md",
        outline: "border bg-background shadow-sm hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 hover:border-primary hover:text-primary hover:shadow-md hover:-translate-y-0.5 active:translate-y-0",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 shadow-sm",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0",
        link: "text-primary underline-offset-4 hover:underline hover:text-primary/80",
      },
      size: {
        default: "h-10 px-6 py-3 has-[>svg]:px-5",
        sm: "h-9 rounded-lg gap-2 px-4 py-2 has-[>svg]:px-3",
        lg: "h-12 rounded-lg px-8 py-4 has-[>svg]:px-6",
        icon: "size-10 rounded-lg",
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
```

### Badge Component

```tsx
// components/ui/badge.tsx
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring/50",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return (
    <div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
```

### Card Component

```tsx
// components/ui/card.tsx
import * as React from "react"
import { cn } from "@/lib/utils"
import { GlowingEffect } from "@/components/ui/glowing-effect"

function Card({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "relative bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-medium)] transition-shadow",
        className
      )}
      {...props}
    >
      <GlowingEffect
        variant="purple"
        blur={12}
        inactiveZone={0.7}
        proximity={96}
        spread={32}
        movementDuration={1.2}
        borderWidth={2}
        disabled={false}
        glow={false}
      />
      {children}
    </div>
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardTitle, CardContent }
```

### Table Component

```tsx
// components/ui/table.tsx
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto border border-[var(--table-border)] rounded-lg"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "[&_tr]:border-b [&_tr]:border-[var(--table-row-border)] text-xs uppercase tracking-wide text-[var(--table-text)]",
        className
      )}
      style={{ background: 'var(--table-header-bg)' }}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-[var(--muted-a50)] data-[state=selected]:bg-[var(--muted)] border-b border-[var(--table-row-border)] transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-4 py-2 text-left align-middle font-medium whitespace-nowrap text-[var(--table-text)] overflow-hidden [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-4 py-3 align-middle whitespace-nowrap font-medium overflow-hidden [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell }
```

### Sidebar Component

```tsx
// components/ui/sidebar.tsx
"use client"

import * as React from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
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
        style={{ ...(style as React.CSSProperties), ...sidebarVars }}
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
          <div className="bg-sidebar flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <aside
      data-slot="sidebar"
      className={cn("text-sidebar-foreground w-(--sidebar-width) border-r bg-sidebar", className)}
      {...props}
    >
      {children}
    </aside>
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
}
```

### Navigation Item Pattern

```tsx
// Example navigation item styling (from AppSidebar.tsx)
<NavLink
  to={item.to}
  className={({ isActive }) => cn(
    'flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
  )}
>
  <Icon />
  <span className="ml-2 text-base font-medium">{item.label}</span>
</NavLink>
```

---

## 7. Utility Functions

### cn() - Class Name Merger

```typescript
// utils/cn.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

```typescript
// lib/utils.ts (re-export for shadcn compatibility)
export { cn } from '@/utils/cn';
```

### useIsMobile Hook

```typescript
// hooks/use-mobile.ts
import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
```

---

## 8. Theme Support

### Theme Classes

Apply to `<html>` or root element:

| Class | Theme |
|-------|-------|
| (none) | Light (default) |
| `.dark` | Dark theme |
| `.modern` | Modern blue theme |

### Theme Switching Example

```typescript
// Store in localStorage
localStorage.setItem('ui:theme', 'dark'); // 'system' | 'dark' | 'modern'

// Apply on load
const theme = localStorage.getItem('ui:theme');
if (theme === 'dark') {
  document.documentElement.classList.add('dark');
} else if (theme === 'modern') {
  document.documentElement.classList.add('modern');
}
```

---

## 9. Responsive Design

### Breakpoint

```typescript
const MOBILE_BREAKPOINT = 768; // px
```

### Mobile Detection

```typescript
import { useIsMobile } from '@/hooks/use-mobile';

function MyComponent() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileLayout />;
  }
  return <DesktopLayout />;
}
```

---

## 10. CSS Files

### index.css (Main Stylesheet)

```css
/* Modern Design System for App */

/* Import the clean theme system */
@import './styles/theme.css';

/* Import Tailwind CSS */
@import 'tailwindcss';

/* Tailwind base layer integration */
@layer base {
  * { border-color: var(--border); }
  html, body, #root {
    width: 100%;
    height: 100%;
    overflow-x: hidden;
    margin: 0;
    padding: 0;
  }
  body {
    background: var(--background-body);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
    color: var(--foreground);
  }
}

/* Application specific component styles */
@layer components {
  /* Simple table container */
  .table-container {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 1px 3px var(--border-a10);
  }

  /* Sidebar component */
  .sidebar {
    border-right: 1px solid var(--sidebar-border);
  }

  /* General card component */
  .card {
    background-color: var(--card);
    color: var(--card-foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 1px 3px var(--border-a10), 0 1px 2px var(--border-a06);
    transition: all var(--transition-normal);
  }

  .card:hover {
    box-shadow: 0 4px 6px var(--border-a10), 0 2px 4px var(--border-a06);
    transform: translateY(-1px);
    border-color: var(--primary-a20);
  }

  /* Dashboard cards */
  .dashboard-card {
    background-color: var(--card);
    color: var(--card-foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 1px 3px var(--border-a10), 0 1px 2px var(--border-a06);
    transition: all var(--transition-normal);
  }

  .dashboard-card:hover {
    box-shadow: 0 4px 6px var(--border-a10), 0 2px 4px var(--border-a06);
    transform: translateY(-2px);
    border-color: var(--primary-a30);
  }

  /* Table styles */
  .data-table {
    background-color: var(--card);
    color: var(--card-foreground);
    font-size: 0.875rem;
    box-shadow: var(--shadow-sm);
    border-radius: var(--radius);
  }

  .data-table th {
    background-color: var(--muted-a50);
    color: var(--muted-foreground);
    border-bottom: 1px solid var(--border);
  }

  .data-table td {
    border-bottom: 1px solid var(--border);
  }

  .data-table tbody tr:hover {
    background-color: var(--muted-a50);
  }

  /* Form sections */
  .form-section {
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }

  /* Status indicators */
  .status-indicator.success {
    background-color: var(--status-success-bg);
    color: var(--status-success-text);
  }

  .status-indicator.warning {
    background-color: var(--status-warning-bg);
    color: var(--status-warning-text);
  }

  .status-indicator.error {
    background-color: var(--status-error-bg);
    color: var(--status-error-text);
  }

  /* Loading spinner */
  .loading-spinner {
    border-color: var(--muted);
    border-top-color: var(--primary);
  }

  /* Page layout */
  .page-title {
    color: var(--foreground);
  }

  .page-description {
    color: var(--muted-foreground);
  }

  /* Settings components */
  .settings-sidebar,
  .settings-content {
    background: var(--table-bg);
    color: var(--table-text);
    border: 1px solid var(--table-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }

  .settings-panel {
    background: var(--table-bg);
    color: var(--table-text);
    border: 1px solid var(--table-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }

  /* Unified form control styles */
  .form-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--table-text);
  }

  .form-label > span {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--table-text);
  }

  .form-input {
    width: 100%;
    height: 2.5rem;
    border: var(--input-border-width) solid var(--input-border);
    background: var(--input-bg);
    background-color: var(--input-bg);
    color: var(--foreground);
    border-radius: 0.375rem;
    padding: 0.5rem;
    box-sizing: border-box;
  }
}

/* Modern theme specific enhancements */
@layer components {
  .modern .sidebar {
    border-right: 2px solid var(--primary-a20);
    box-shadow: 2px 0 8px var(--border-a10);
  }

  .modern header {
    background: var(--background);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 2px solid var(--primary-a20);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.25);
  }

  .modern header button {
    position: relative;
    overflow: hidden;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .modern header button::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--primary-a20), transparent);
    transition: left 0.6s ease;
  }

  .modern header button:hover {
    transform: translateY(-2px) scale(1.05);
    box-shadow: 0 4px 12px var(--primary-a30);
    border-color: var(--primary);
  }

  .modern header button:hover::before {
    left: 100%;
  }

  .modern .dashboard-card {
    border: 1px solid var(--border-a10);
    box-shadow: 0 4px 6px var(--border-a08), 0 2px 4px var(--border-a06);
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  }

  .modern .dashboard-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--primary-a10), transparent);
    transition: left 0.8s ease;
  }

  .modern .dashboard-card:hover {
    box-shadow: 0 12px 24px var(--primary-a15), 0 6px 12px var(--border-a08);
    transform: translateY(-4px) scale(1.02);
    border-color: var(--primary-a30);
  }

  .modern .dashboard-card:hover::before {
    left: 100%;
  }

  .modern .dashboard-card:hover::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, var(--primary), var(--accent), var(--primary));
    animation: shimmer 2s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }

  .modern .table-container {
    border-color: var(--primary-a20);
    box-shadow: 0 4px 12px var(--primary-a15);
  }

  .modern .card {
    border-color: var(--primary-a20);
    box-shadow: 0 2px 8px var(--primary-a10);
  }

  .modern .card:hover {
    border-color: var(--primary-a30);
    box-shadow: 0 6px 16px var(--primary-a15);
    transform: translateY(-2px);
  }
}
```

---

## 11. Tailwind Configuration

### tailwind.config.ts

```typescript
import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Modern professional font stack
      fontFamily: {
        sans: ['"Geist Variable"', 'Geist', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
      },

      // Design system colors mapped to CSS variables
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)'
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)'
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)'
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)'
        },

        // Status colors
        success: {
          50: 'var(--success-50)',
          100: 'var(--success-100)',
          500: 'var(--success-500)',
          700: 'var(--success-700)',
          900: 'var(--success-900)'
        },
        warning: {
          50: 'var(--warning-50)',
          100: 'var(--warning-100)',
          500: 'var(--warning-500)',
          700: 'var(--warning-700)',
          900: 'var(--warning-900)'
        },
        error: {
          50: 'var(--error-50)',
          100: 'var(--error-100)',
          500: 'var(--error-500)',
          700: 'var(--error-700)',
          900: 'var(--error-900)'
        },
      },

      // Border radius using design tokens
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      // Shadows using design tokens
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-base)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
      },

      // Animation and transitions
      transitionDuration: {
        fast: 'var(--transition-fast)',
        normal: 'var(--transition-normal)',
        slow: 'var(--transition-slow)',
      },

      animation: {
        pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        spin: 'spin 1s linear infinite',
      },
    }
  },
  plugins: [],
} satisfies Config;
```

### postcss.config.cjs

```javascript
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  }
}
```

### components.json (shadcn/ui compatibility)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/utils"
  }
}
```

---

## Quick Start

1. Install dependencies from Section 1
2. Copy the file structure from Section 2
3. Copy CSS files (theme.css and index.css)
4. Copy tailwind.config.ts and postcss.config.cjs
5. Copy utility functions (cn.ts, use-mobile.ts)
6. Copy UI components as needed
7. Import Geist font in your main entry file:
   ```typescript
   import '@fontsource-variable/geist';
   ```
8. Set up your index.html with the root element:
   ```html
   <div id="root"></div>
   ```

---

## License

This design system is extracted from the NestWatcher Electron application for internal reuse.
