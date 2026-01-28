# Codebase Audit (Woodtron / NestWatcher)

Scope: quick audit of theming/styling, UI consistency, and obvious security risks. No code changes made; tests not run (read-only review).

## Findings (ordered by severity)

1) Missing design tokens referenced by Tailwind (High)  
- Evidence: `packages/renderer/tailwind.config.ts:18-134` maps many palette keys to CSS variables such as `--primary-50`, `--secondary-900`, `--success-700`, but none of those variables exist in `packages/renderer/src/styles/theme.css` (themes only define the base tokens like `--primary`, `--secondary`, etc.).  
- Impact: any Tailwind class that expects those shade tokens (e.g., `text-primary-200`) will render as `var(--primary-200)` with no fallback, leading to unstyled or invisible text/backgrounds, especially when porting to light mode.  
- Fix: either add the full set of shade variables for each theme in `theme.css`, or remove the unused shade entries from `tailwind.config.ts` and stick to the base tokens (`--primary`, `--secondary`, etc.).

2) Shadows/transitions tokens are used but not defined (Medium)  
- Evidence: `packages/renderer/src/index.css:88-125` and `packages/renderer/src/components/ui/card.tsx:1-40` reference `--shadow-sm`, `--shadow-blue-sm`, `--shadow-blue-md`, `--shadow-soft`, `--shadow-medium`, plus `--transition-normal`. None of these are declared in `packages/renderer/src/styles/theme.css`.  
- Impact: cards/tables/buttons fall back to “no shadow” and some transitions resolve to `var(--transition-normal)` (undefined), so interactive affordances look flat or broken—most visible in the light theme.  
- Fix: define these tokens once in `theme.css` (e.g., the values listed in `docs/STYLING.md` lines ~260-300), or replace usages with explicit box-shadow/transition values.

3) Renderer theme state diverges from Main/Electron preference (Medium)  
- Evidence: Main stores `ThemePreference = 'system' | 'light' | 'dark' | 'modern'` and applies it to Electron (`packages/main/src/services/uiState.ts:7-133`). The renderer’s `ThemeContext` has its own theme list (`'light' | 'sunset' | 'dark-teal' | 'dark-green' | 'dark-charcoal'`) and persists to `localStorage` (`packages/renderer/src/contexts/ThemeContext.tsx:1-70`).  
- Impact: the app window can report one theme to Electron/OS while the React UI paints a different one. Users switching themes in the UI won’t persist that choice through the Main process, and “system”/“light” modes from Main are ignored in the renderer.  
- Fix: unify the theme contract—either pipe renderer changes through the existing UI theme IPC (or extend it), or have the renderer read the stored preference from Main on startup so both layers agree.

4) Primary/Destructive buttons bypass theme tokens (Resolved)  
- Evidence: `packages/renderer/src/components/ui/button.tsx:12-27` now reads from CSS variables (`--blue-button-*`, `--red-button-*`) instead of hard-coded Tailwind palette colors.  
- Impact: button colors can be adjusted per theme in one place (`packages/renderer/src/styles/theme.css`) without changing component code.  
- Fix: implemented.

5) CSP allows inline/eval scripts and remote CDNs (Medium, security)  
- Evidence: `packages/main/src/ipc/hypernest.ts:230-244` sets CSP for the NC-Cat window: `"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com …"`.  
- Impact: inline/eval significantly weakens renderer protections and depends on remote CDNs being trustworthy/available. This may be intentional for dev, but it is risky for production packaging.  
- Fix: for packaged builds, remove `unsafe-inline`/`unsafe-eval` and bake needed assets locally (or gate the permissive CSP behind a dev flag).

## Recommended next steps
- Define or remove the missing color/shadow/transition tokens so Tailwind utilities resolve to real values across all themes. Start with the `light` palette to stabilize light mode.  
- Decide on a single source of truth for theme preference (Main vs Renderer) and wire the other side to follow it.  
- Tokenize primary/destructive button colors to keep visual consistency across themes.  
- Tighten CSP for production; keep permissive rules only for development if absolutely necessary.

## Testing
- Not run (audit only).
