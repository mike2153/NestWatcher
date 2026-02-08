# Woodtron UI Style Guide

This is the “copy/paste spec” for Woodtron’s UI: colors, radii, typography, component shapes, and the App Sidebar behavior — so you can reuse it as a skeleton in another app.

If you want “the light theme”, the app’s intended light palette is `light`.

## Source Of Truth Files

- Theme tokens: `packages/renderer/src/styles/theme.css`
- Global base/component CSS: `packages/renderer/src/index.css`
- Tailwind mapping (tokens → Tailwind names): `packages/renderer/tailwind.config.ts`
- Core UI primitives: `packages/renderer/src/components/ui/`
- App sidebar: `packages/renderer/src/components/AppSidebar.tsx`
- Sidebar primitives (collapse + mobile sheet): `packages/renderer/src/components/ui/sidebar.tsx`
- App shell layout (header + sidebar width override): `packages/renderer/src/shell/AppLayout.tsx`

## Technology Stack

- Tailwind CSS (utility classes)
- CSS variables (theme tokens like `--background`, `--primary`, etc.)
- CVA (class-variance-authority) for variants (buttons/badges)
- Radix UI (Sheet/Dialog primitives)
- Lucide React icons

## Themes

Theme is applied by adding a class to the `<html>` element.

- Implemented in: `packages/renderer/src/contexts/ThemeContext.tsx`
- Theme classes used: `light`, `sunset`, `dark-teal`, `dark-green`, `dark-charcoal`
- Special rule: for all dark palettes, the code also adds the `dark` class so Tailwind’s `dark:` variant works.

## Typography

### Font family

- Global font is set on `body` in `packages/renderer/src/index.css`:
  - `'Geist', 'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, sans-serif`
- Tailwind config also maps `font-sans` to Geist first: `packages/renderer/tailwind.config.ts`

### Base font size and “common sizes” used in components

The app’s “base” is 14px:

- `body`: `font-size: 0.875rem` (14px) in `packages/renderer/src/index.css`

Common sizes you’ll see repeatedly:

- `text-xs` (12px): table headers (`TableHeader`), small pills/badges (unread badge, “Active” tag in Theme Modal)
- `text-sm` (14px): sidebar items, inputs, most buttons, most body text
- `text-base` (16px): some modal subtitles and splash UI
- `text-lg` (18px): Settings modal header title, Sheet title
- `text-xl` (20px): App sidebar brand (“Woodtron”), Theme Modal title

## Shape System (Radii / Component Geometry)

### Base radius token

- In `packages/renderer/src/styles/theme.css`: `--radius: 0.5rem` (8px)

### What actually gets used

Woodtron mixes the base token with a few “fixed” radii for specific shapes:

- **Inputs/selects**: `border-radius: 4px` (global rule for native form controls) in `packages/renderer/src/index.css`
- **Buttons & sidebar items**: `rounded-md` (Tailwind) ≈ 6px
- **Tables**: `rounded-lg` (Tailwind) ≈ 8px
- **Cards & modals**: `rounded-xl` (Tailwind) ≈ 12px
- **Pills**: `rounded-full` (badges/counters/status dots)

## Color Tokens (Design Tokens)

All themeable colors come from CSS variables in `packages/renderer/src/styles/theme.css`.

### Core tokens (used everywhere)

- Backgrounds: `--background`, `--background-body`, `--background-elevated`, `--background-subtle`
- Text: `--foreground`, `--foreground-muted`, `--foreground-subtle`
- Surfaces: `--card`, `--card-foreground`, `--card-hover`
- Primary action: `--primary`, `--primary-hover`, `--primary-foreground`
- Neutrals: `--secondary`, `--secondary-foreground`, `--secondary-hover`, `--muted`, `--muted-foreground`
- Borders: `--border`, `--border-subtle`, `--border-strong`
- Focus ring: `--ring`, `--ring-glow`
- Sidebar: `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`
- Table: `--table-bg`, `--table-header-bg`, `--table-text`, `--table-border`, `--table-row-border`, `--table-hover-bg`, `--table-selected-bg`
- Status: `--status-success-*`, `--status-warning-*`, `--status-error-*`, `--status-info-*`
- Scrollbar: `--scrollbar-track`, `--scrollbar-thumb`, `--scrollbar-thumb-hover`
- Buttons: `--blue-button-*`, `--red-button-*` (explicit “primary” and “destructive” button colors)

### “Light theme” values you probably want to port (`light`)

These are the exact values from the `.light` block in `packages/renderer/src/styles/theme.css`:

- Background: `--background`/`--background-body` = `hsl(40 20% 98%)`
- Elevated: `--background-elevated` = `hsl(0 0% 100%)`, `--background-subtle` = `hsl(40 10% 94%)`
- Text: `--foreground` = `hsl(220 25% 12%)`, `--muted-foreground` = `hsl(220 10% 45%)`
- Primary: `--primary` = `hsl(220 65% 28%)`, `--primary-foreground` = `hsl(40 20% 98%)`
- Accent blue (links/rings): `--accent-blue` = `#2563eb`, `--accent-blue-subtle` = `rgba(37, 99, 235, 0.1)`
- Borders: `--border` = `hsl(40 15% 88%)`
- Sidebar bg: `--sidebar` = `hsl(220 20% 97%)`
- Table header bg: `--table-header-bg` = `hsl(40 10% 96%)`

## Global Interaction Rules (Focus / Hover)

### Form control borders and focus

Defined in `packages/renderer/src/index.css`:

- Inputs/selects/textareas have `border-width: 1.5px`
- Focus state:
  - `border-color: var(--accent-blue)`
  - `box-shadow: 0 0 0 2px var(--accent-blue-subtle)`

## Component Specs (The “Skeleton” Pieces)

### Button (`packages/renderer/src/components/ui/button.tsx`)

- Base: `rounded-md`, `text-sm`, icon size defaults to `size-4`
- Sizes:
  - `default`: `h-10 px-4 py-2`
  - `sm`: `h-8 px-3 py-1.5`
  - `lg`: `h-11 px-6 py-3`
  - `icon`: `size-10` (square)
- Variants (important detail):
  - `default` uses CSS variables (`--blue-button-*`) so the exact color is controlled in `packages/renderer/src/styles/theme.css`
  - `destructive` uses CSS variables (`--red-button-*`)
  - `outline` / `secondary` / `ghost` use theme tokens (`var(--border)`, `var(--card)`, etc.)

### Input (`packages/renderer/src/components/ui/input.tsx`)

- Size: `h-9` (36px)
- Shape: `rounded-md`
- Text: `text-sm`
- Border: `border-border` (maps to `var(--border)`)
- Focus: `ring-1 ring-ring` (maps to `var(--ring)`)

### Badge (`packages/renderer/src/components/ui/badge.tsx`)

- Shape: `rounded-md`
- Text: `text-xs font-semibold`
- Padding: `px-2 py-0.5`
- Variants: `default`, `secondary`, `destructive`, `outline`

### Card (`packages/renderer/src/components/ui/card.tsx`)

- Shape: `rounded-xl`
- Border: `border`
- Padding: `py-6`, internal layout uses `px-6`
- Visual: uses `GlowingEffect` overlay (teal variant) for the “neon edge” vibe

### Table (`packages/renderer/src/components/ui/table.tsx`)

- Container: `border` + `rounded-lg` + horizontal scroll
- Header text: `text-xs uppercase tracking-wide`
- Header cell height: `h-10`
- Row hover behavior:
  - `hover:bg-[var(--accent-blue-subtle)]`
  - `hover:outline-2 hover:outline-[var(--accent-blue)]`

### Sheet (mobile sidebar drawer) (`packages/renderer/src/components/ui/sheet.tsx`)

- Overlay: `bg-black/80`
- Content default: `bg-[var(--card)] p-6 shadow-lg`, plus a side border depending on placement

## App Sidebar Spec (Design + Features)

### Layout + sizing

- Sidebar primitives: `packages/renderer/src/components/ui/sidebar.tsx`
  - Full width: `13rem` (`SIDEBAR_WIDTH`)
  - Collapsed icon width: `3rem` (`SIDEBAR_WIDTH_ICON`)
- The app overrides sidebar width in the shell:
  - `packages/renderer/src/shell/AppLayout.tsx` sets `--sidebar-width: 12rem`
- Sidebar header area is `h-12` with `px-3` padding.
- Nav items are consistent “chips”:
  - Height: `h-10` (40px)
  - Shape: `rounded-md`
  - Icon: `size-4`
  - Text: `text-sm font-medium`
  - Padding: `pl-4 pr-3`

### Colors and states

From `packages/renderer/src/components/AppSidebar.tsx`:

- Inactive item:
  - Text: `var(--muted-foreground)`
  - Hover bg: `var(--accent-blue-subtle)`
  - Hover text: `var(--foreground)`
- Active item:
  - Background: `var(--primary)`
  - Text: `var(--primary-foreground)`

### Navigation (routes shown in sidebar)

From `packages/renderer/src/components/AppSidebar.tsx`:

- `/dashboard` Dashboard
- `/jobs` Jobs
- `/router` Router
- `/history` History
- `/grundner` Grundner
- `/ordering` Ordering
- `/telemetry` Telemetry
- `/messages` Messages (shows unread badge)
- `/cnc-alarms` CNC Alarms

### Sidebar features and behavior

- Collapsible:
  - Desktop collapses to icon-only; labels hide via `group-data-[collapsible=icon]/sidebar-wrapper:hidden`
- Mobile:
  - Sidebar becomes a Sheet (slide-out drawer) using `Sheet`/`SheetContent`
- Unread message badge:
  - Shows on Messages when `unreadCount > 0`, capped at `99+`
  - Badge style: `h-5 rounded-full bg-red-500 text-xs font-semibold text-white`
- Status indicator (signed-in + DB connection):
  - Shows a pulsing dot (green for OK, red after 5 seconds of DB outage)
  - Tooltip/aria-label switches between “Authenticated” and “Database disconnected”
- Footer actions:
  - “Open NC Catalyst” button (calls `window.api.ncCatalyst.open()`)
  - Theme switcher (opens Theme Modal)
  - Settings (available to signed-in users; admin-only categories remain restricted inside `SettingsModal`)
  - Login/Logout toggle (based on session)

## Missing Token Notes (Important When Porting)

Some CSS variables are referenced in components/CSS but are NOT defined in `packages/renderer/src/styles/theme.css` yet (they were likely part of an earlier “token plan”).

If you’re copying the UI to another app, you should define these in your global CSS:

- Shadows referenced: `--shadow-sm`, `--shadow-blue-sm`, `--shadow-blue-md`, `--shadow-soft`, `--shadow-medium`
- Transitions referenced: `--transition-normal`

## Porting Checklist (Fastest Way To Clone The UI)

1. Copy `packages/renderer/src/styles/theme.css` and the `light` block
2. Copy `packages/renderer/src/index.css` (base font, focus rules, shared classes)
3. Copy `packages/renderer/tailwind.config.ts` (token mapping + font stack)
4. Copy `packages/renderer/src/components/ui/` (Button/Input/Card/Table/Sidebar/Sheet)
5. Copy `packages/renderer/src/components/AppSidebar.tsx` and `packages/renderer/src/components/ThemeSwitcher.tsx` if you want the same sidebar UX
