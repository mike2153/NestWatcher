# Codebase Audit (Woodtron / NestWatcher)

Scope: quick audit of theming/styling, UI consistency, and obvious security risks. Changes were made to address the items below; tests were not run in this environment due to a broken `node_modules` state.

## Findings (ordered by severity)

1) Missing design tokens referenced by Tailwind (Resolved)  
- Evidence: `packages/renderer/tailwind.config.ts` no longer maps to missing shade variables like `--success-700` / `--warning-200` / `--neutral-50`. Instead, `success` and `warning` map to tokens that exist in `packages/renderer/src/styles/theme.css`.  
- Impact: removes “silent missing var” cases for these semantic colors and makes `text-success`, `text-warning`, `border-success`, `border-warning` resolve reliably.  
- Fix: implemented.

2) Shadows/transitions tokens are used but not defined (Resolved)  
- Evidence: `packages/renderer/src/styles/theme.css` now defines `--shadow-soft`, `--shadow-medium`, `--shadow-blue-sm`, `--shadow-blue-md`, plus `--transition-fast|normal|slow`.  
- Impact: removes undefined-variable fallbacks for cards/settings panels and keeps hover/focus effects consistent across themes.  
- Fix: implemented.

3) Renderer theme state diverges from Main/Electron preference (Medium)  
- Evidence: Main stores `ThemePreference = 'system' | 'light' | 'dark' | 'modern'` and applies it to Electron (`packages/main/src/services/uiState.ts:7-133`). The renderer’s `ThemeContext` has its own theme list (`'light' | 'sunset' | 'dark-teal' | 'dark-green' | 'dark-charcoal'`) and persists to `localStorage` (`packages/renderer/src/contexts/ThemeContext.tsx:1-70`).  
- Impact: the app window can report one theme to Electron/OS while the React UI paints a different one. Users switching themes in the UI won’t persist that choice through the Main process, and “system”/“light” modes from Main are ignored in the renderer.  
- Fix: unify the theme contract—either pipe renderer changes through the existing UI theme IPC (or extend it), or have the renderer read the stored preference from Main on startup so both layers agree.

4) Primary/Destructive buttons bypass theme tokens (Resolved)  
- Evidence: `packages/renderer/src/components/ui/button.tsx:12-27` now reads from CSS variables (`--blue-button-*`, `--red-button-*`) instead of hard-coded Tailwind palette colors.  
- Impact: button colors can be adjusted per theme in one place (`packages/renderer/src/styles/theme.css`) without changing component code.  
- Fix: implemented.

5) CSP allows inline/eval scripts and remote CDNs (Mitigated)  
- Evidence: `packages/main/src/ipc/hypernest.ts` now builds CSP dynamically: relaxed in dev, but packaged builds use a stricter policy without `unsafe-inline`/`unsafe-eval` in `script-src`.  
- Impact: packaged builds are no longer dependent on eval/inline scripts (and are less dependent on remote CDNs).  
- Fix: implemented for packaged builds; dev remains permissive by design.

## Recommended next steps
- Decide on a single source of truth for theme preference (Main vs Renderer) and wire the other side to follow it.  
- Verify NC-Cat packaged `index.html` does not rely on remote script CDNs or inline/eval scripts (otherwise the stricter packaged CSP will block them).

## Testing
- Not run here (workspace `node_modules` is currently in a broken state in this environment). Run `pnpm install` then `pnpm dev` and confirm Settings inputs + NC-Cat window still function.
