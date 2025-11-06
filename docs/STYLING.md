# NestWatcher Styling Guide

Complete styling reference for replicating the NestWatcher application design system.

---

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Typography](#typography)
3. [Color System](#color-system)
4. [Component Libraries](#component-libraries)
5. [Layout & Spacing](#layout--spacing)
6. [Animations & Transitions](#animations--transitions)
7. [Theme Implementation](#theme-implementation)
8. [Usage Guidelines](#usage-guidelines)

---

## Technology Stack

### Core Styling Technologies

- **Tailwind CSS v4.1.13** - Utility-first CSS framework
- **PostCSS & Autoprefixer** - CSS processing
- **CSS Variables** - Theme tokens and dynamic theming
- **class-variance-authority (CVA)** - Component variant management
- **tailwind-merge & clsx** - Conditional class name utilities

### Installation

```bash
npm install tailwindcss@^4.1.13 postcss autoprefixer
npm install class-variance-authority clsx tailwind-merge
```

---

## Typography

### Font Families

**Primary Font:** [Geist Variable](https://vercel.com/font)
- Variable font with weights 100-900
- Installed via `@fontsource-variable/geist`

**Monospace Font:** JetBrains Mono (with fallbacks)

```typescript
// tailwind.config.ts
fontFamily: {
  sans: ['"Geist Variable"', 'Geist', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
  mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
}
```

### Font Sizes

The app uses Tailwind's default scale with custom line heights:
- `text-xs` - Extra small (0.75rem)
- `text-sm` - Small (0.875rem)
- `text-base` - Base (1rem)
- `text-lg` - Large (1.125rem)
- `text-xl` - Extra large (1.25rem)
- `text-2xl` through `text-4xl` - Display sizes

### Font Application

```css
/* Global font application in theme.css */
body, button, input, select, textarea {
  font-family: "Geist Variable", Geist, Inter, -apple-system, sans-serif;
}
```

---

## Color System

### Theme Architecture

Colors are managed through **CSS variables** in `packages/renderer/src/styles/theme.css`. This allows for:
- Dynamic theme switching
- Centralized color management
- Consistent design tokens

### Color Themes

**Three themes are supported:**
1. **Light** (default) - `:root`
2. **Dark** - `.dark`
3. **Modern** - `.modern`

### Semantic Color Tokens

#### Core Semantic Colors

```css
--background         /* Main app background */
--background-body    /* Body/content area background */
--foreground         /* Main text color */
--card               /* Card backgrounds */
--card-foreground    /* Card text */
--primary            /* Primary action color (indigo #1647e0) */
--destructive        /* Destructive actions (red) */
--muted              /* Muted backgrounds */
--muted-foreground   /* Muted text */
--border             /* Border color */
```

#### Component-Specific Tokens

**Table Colors:**
```css
--table-bg           /* Table background */
--table-header-bg    /* Table header background */
--table-text         /* Table text color */
--table-border       /* Table outer border */
--table-row-border   /* Row separator lines */
--table-hover-bg     /* Row hover state */
--table-selected-bg  /* Row selection state */
```

**Sidebar Colors:**
```css
--sidebar            /* Sidebar background (metallic/marble gradient) */
--sidebar-foreground /* Sidebar text color */
--sidebar-accent     /* Active item background */
--sidebar-border     /* Sidebar border */
```

**Input Colors:**
```css
--input-bg           /* Input field background (#f3f4f6) */
--input-border       /* Input border color */
--input-border-width /* Input border width (1.5px) */
```

**Status Colors:**
```css
--status-success-bg, --status-success-text
--status-warning-bg, --status-warning-text
--status-error-bg, --status-error-text
```

### Alpha/Transparency Tokens

Using `color-mix()` for transparency:

```css
--muted-a50      /* 50% opacity muted */
--primary-a10    /* 10% opacity primary */
--primary-a15    /* 15% opacity primary */
--primary-a20    /* 20% opacity primary */
--primary-a30    /* 30% opacity primary */
--border-a06     /* 6% opacity border */
--border-a08     /* 8% opacity border */
--border-a10     /* 10% opacity border */
--border-a30     /* 30% opacity border */
```

### Light Theme Colors

```css
:root {
  --background: linear-gradient(135deg, theme('colors.neutral.200') 0%, theme('colors.neutral.100') 50%, theme('colors.neutral.100') 100%);
  --background-body: linear-gradient(to right, #feffff 0%, #feffff 100%);
  --foreground: theme('colors.zinc.900');
  --primary: #1647e0;  /* Vibrant indigo */
  --table-bg: #feffff;
  --table-header-bg: #e2e2e2;
  --sidebar: #f7f6f6;  /* Metallic/marble effect */
}
```

---

## Component Libraries

### UI Components

**Custom Components** (shadcn/ui inspired):
Located in `packages/renderer/src/components/ui/`

- **Button** (`button.tsx`) - CVA-based button variants
- **Card** (`card.tsx`) - Card container components
- **Sheet** (`sheet.tsx`) - Side panel/drawer (Radix UI Dialog)
- **Separator** (`separator.tsx`) - Visual divider
- **Badge** (`badge.tsx`) - Status badges
- **Sidebar** (`sidebar.tsx`) - Application sidebar
- **Context Menu** (`context-menu.tsx`) - Right-click menus
- **Table** (`table.tsx`) - Table components

### Third-Party UI Libraries

```json
{
  "@radix-ui/react-dialog": "^1.1.15",
  "@radix-ui/react-separator": "^1.1.7",
  "@radix-ui/react-slot": "^1.2.3",
  "@tanstack/react-table": "^8.15.0",
  "lucide-react": "^0.462.0"
}
```

- **Radix UI** - Unstyled accessible components
- **TanStack Table** - Powerful table/data grid
- **Lucide React** - Icon library
- **Recharts** - Charts and data visualization
- **Motion (Framer Motion)** - Animations

### Button Variants

```typescript
// From button.tsx
variants: {
  variant: {
    default,    // Primary action (indigo, elevated)
    destructive, // Destructive action (red)
    outline,    // Secondary outlined
    secondary,  // Secondary filled
    ghost,      // Minimal hover-only
    link        // Text link style
  },
  size: {
    default,    // h-10 px-6 py-3
    sm,         // h-9 px-4 py-2
    lg,         // h-12 px-8 py-4
    icon        // size-10 (square)
  }
}
```

All buttons feature:
- Hover elevation (`-translate-y-0.5`)
- Shadow transitions
- 200ms transitions
- Focus ring states

---

## Layout & Spacing

### Border Radius

```css
--radius: 0.75rem;  /* Base radius */
```

```typescript
borderRadius: {
  lg: 'var(--radius)',                    // 0.75rem
  md: 'calc(var(--radius) - 2px)',        // ~0.625rem
  sm: 'calc(var(--radius) - 4px)',        // ~0.5rem
}
```

### Shadows

```css
--shadow-sm:   0 1px 2px 0 rgba(0,0,0,0.05);
--shadow-base: 0 1px 3px 0 rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.10);
--shadow-md:   0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10);
--shadow-lg:   0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.10);
--shadow-xl:   0 20px 25px -5px rgba(0,0,0,0.10), 0 8px 10px -6px rgba(0,0,0,0.10);
```

### Spacing Scale

Uses Tailwind's default spacing with custom tokens:

```typescript
spacing: {
  '0': 'var(--spacing-0)',   // 0
  '1': 'var(--spacing-1)',   // 0.25rem
  '2': 'var(--spacing-2)',   // 0.5rem
  '3': 'var(--spacing-3)',   // 0.75rem
  '4': 'var(--spacing-4)',   // 1rem
  '5': 'var(--spacing-5)',   // 1.25rem
  '6': 'var(--spacing-6)',   // 1.5rem
  '8': 'var(--spacing-8)',   // 2rem
  '10': 'var(--spacing-10)', // 2.5rem
  '12': 'var(--spacing-12)', // 3rem
  '16': 'var(--spacing-16)', // 4rem
}
```

---

## Animations & Transitions

### Transition Speeds

```css
--transition-fast:   150ms ease;
--transition-normal: 200ms ease;
--transition-slow:   300ms ease;
```

```typescript
transitionDuration: {
  fast: 'var(--transition-fast)',     // 150ms
  normal: 'var(--transition-normal)', // 200ms
  slow: 'var(--transition-slow)',     // 300ms
}
```

### Common Animations

```typescript
animation: {
  pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  spin: 'spin 1s linear infinite',
}
```

### Interactive States

**Buttons:**
- Hover: `-translate-y-0.5` + `shadow-lg`
- Active: `translate-y-0`
- Transition: `200ms all`

**Tables:**
- Hover: `bg-[var(--table-hover-bg)]`
- Selected: `bg-[var(--table-selected-bg)]`

---

## Theme Implementation

### Theme Switching

Theme is applied via class on `<html>` element:

```typescript
// Light theme (default)
document.documentElement.className = '';

// Dark theme
document.documentElement.className = 'dark';

// Modern theme
document.documentElement.className = 'modern';
```

Managed in `packages/renderer/src/shell/AppLayout.tsx`

### Theme File Structure

```
packages/renderer/src/styles/
└── theme.css          # All theme tokens and utility classes
```

### Key Utility Classes

```css
/* Background utilities */
.bg-background    /* Main app background with gradient */
.bg-card          /* Card background with subtle shadow */
.bg-table         /* Table background */
.bg-sidebar       /* Sidebar with metallic gradient */

/* Text utilities */
.text-foreground
.text-muted-foreground
.text-accent-foreground
.table-text       /* Table text color */

/* Page elements */
.page-title-gradient  /* Gradient text for page titles */
```

### Input Field Styling

All form inputs receive consistent styling:

```css
input[type="text"],
input[type="search"],
input[type="number"],
/* ... all input types ... */
select,
textarea {
  border: var(--input-border-width) solid var(--input-border) !important;
  background: var(--input-bg) !important;
  border-radius: 0.375rem;
  padding: 0.5rem;
}
```

---

## Usage Guidelines

### Do's

✅ **Change colors by editing `theme.css` variables only**
```css
/* Good: Edit in theme.css */
:root {
  --primary: #1647e0;
}
```

✅ **Use Tailwind classes mapped to variables**
```tsx
<div className="bg-primary text-primary-foreground" />
<div className="bg-[var(--table-bg)] text-[var(--table-text)]" />
```

✅ **Use CVA for component variants**
```tsx
const buttonVariants = cva("base-classes", {
  variants: { /* ... */ }
});
```

✅ **Use semantic color tokens**
```tsx
<button className="bg-primary hover:bg-primary/90" />
```

### Don'ts

❌ **Don't add hardcoded hex/rgb in components**
```tsx
// Bad
<div style={{ color: '#1647e0' }} />

// Good
<div className="text-primary" />
```

❌ **Don't create per-component color definitions**
```tsx
// Bad
const MyComponent = styled.div`
  background: #ffffff;
`;

// Good
const MyComponent = () => <div className="bg-card" />;
```

❌ **Don't bypass the theme system**

### Component Creation Pattern

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const componentVariants = cva(
  "base-classes transition-all",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border border-border bg-background"
      },
      size: {
        default: "h-10 px-4",
        sm: "h-9 px-3"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export function Component({
  className,
  variant,
  size,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof componentVariants>) {
  return (
    <div
      className={cn(componentVariants({ variant, size, className }))}
      {...props}
    />
  );
}
```

---

## Adding New Themes

To create a new theme (e.g., "corporate"):

1. **Add theme scope in `theme.css`:**
```css
.corporate {
  --background: #f0f0f0;
  --foreground: #1a1a1a;
  --primary: #0066cc;
  /* ... all other tokens ... */
}
```

2. **Apply theme:**
```typescript
document.documentElement.className = 'corporate';
```

3. **Ensure all semantic tokens are defined** to maintain consistency across all UI elements.

---

## Quick Reference

### File Locations

- **Theme tokens:** `packages/renderer/src/styles/theme.css`
- **Tailwind config:** `packages/renderer/tailwind.config.ts`
- **UI components:** `packages/renderer/src/components/ui/`
- **Theme switcher:** `packages/renderer/src/shell/AppLayout.tsx`

### Key Dependencies

```json
{
  "tailwindcss": "^4.1.13",
  "@fontsource-variable/geist": "^5.2.8",
  "class-variance-authority": "^0.7.0",
  "clsx": "^2.1.1",
  "tailwind-merge": "^2.3.0",
  "@radix-ui/react-dialog": "^1.1.15",
  "@tanstack/react-table": "^8.15.0",
  "lucide-react": "^0.462.0"
}
```

### Common Classes

```tsx
// Backgrounds
className="bg-background bg-card bg-primary bg-muted"

// Text
className="text-foreground text-muted-foreground text-primary"

// Borders
className="border border-border rounded-lg"

// Shadows
className="shadow-sm shadow-md shadow-lg"

// Interactive
className="hover:bg-accent hover:-translate-y-0.5 transition-normal"
```

---

## Summary

To replicate NestWatcher's styling in another application:

1. Install dependencies: Tailwind CSS v4, CVA, Geist font, Radix UI, TanStack Table, Lucide icons
2. Copy `theme.css` with all color tokens and utilities
3. Copy `tailwind.config.ts` configuration
4. Copy UI components from `components/ui/`
5. Apply global font (Geist Variable) via CSS
6. Implement theme switching on `<html>` element
7. Use semantic color tokens exclusively
8. Follow CVA pattern for component variants
9. Maintain spacing, shadow, and transition tokens

This creates a cohesive, themeable, and maintainable design system.
