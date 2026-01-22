# Dark Theme Tailwind dark: Issue - Findings and Plan

## Summary
The app applies theme classes to the root element, but Tailwind defaults to media-based dark mode when no config is loaded. Also, forcing the config via `@config` breaks layout because the config expects design-token CSS variables (spacing, font sizes, etc.) that are not defined. We need a class-based dark variant without enabling the config.

## Root cause
- Without a config, Tailwind v4 uses media-based dark mode, so `dark:` only applies when the OS is dark.
- Enabling the config via `@config` switches to class-based dark mode, but it also replaces Tailwind defaults with CSS-variable tokens like `var(--spacing-1)`. Those variables are not defined, so most layout utilities collapse and the UI looks unstyled.

## Evidence in repo
- Theme classes are set on the root element:
  - `packages/renderer/src/theme-preload.ts`
  - `packages/renderer/src/contexts/ThemeContext.tsx`
- Tailwind config explicitly sets class-based dark mode:
  - `packages/renderer/tailwind.config.ts` has `darkMode: 'class'`
- The renderer CSS does not load the Tailwind config:
  - `packages/renderer/src/index.css` has no `@config` directive
- `dark:` utilities exist in UI code (example):
  - `packages/renderer/src/components/NcCatValidationResultsModal.tsx` uses `dark:text-amber-300`

## Fix (no light theme changes)
Keep Tailwind in zero-config mode (to preserve styling) and explicitly define a class-based `dark` variant.

Recommended minimal change:
- Add this line in `packages/renderer/src/index.css` after the `@import` lines:
  - `@custom-variant dark ".dark &";`

## Rollout plan
1) Add the `@custom-variant` line in `packages/renderer/src/index.css` after the `@import` lines.
2) Run the app in dev mode.
3) Switch to `dark`, `forest`, and `supabase` themes while keeping the OS theme light.
4) Verify that `dark:` utilities are now class-based and visible.
5) Confirm light themes are unchanged.

## Verification checklist
- In DevTools, run:
  - `document.documentElement.classList` should include `dark` when a dark theme is active.
- Inspect compiled CSS for a `dark:` utility:
  - It should be emitted as a `.dark .text-amber-300` style, not inside `@media (prefers-color-scheme: dark)`.
- Visual check:
  - Elements with `dark:*` classes (e.g., warning icon in `NcCatValidationResultsModal`) should change color immediately when a dark theme is selected.

## Notes
- This does not alter any light theme colors or design tokens.
- It only makes `dark:` respond to the class that the app already sets on the root element.
