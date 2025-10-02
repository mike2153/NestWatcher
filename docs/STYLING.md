Styling Guide (Themes & Tokens)

Overview
- One global theme file controls all colors: `packages/renderer/src/styles/theme.css`.
- Exactly three themes are supported: light (default), dark (`.dark`), and modern (`.modern`).
- All colors are hex values so you can edit them directly.
- Tailwind is wired to CSS variables, so utility classes like `bg-primary-600` still work.

Where To Edit Colors
- File: `packages/renderer/src/styles/theme.css`
- Scopes:
  - `:root` → light
  - `.dark` → dark
  - `.modern` → modern
- Change semantic tokens to update the whole app:
  - `--background`, `--foreground`, `--card`, `--border`, `--input`, `--ring`
  - `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`
  - Table tokens: `--table-bg`, `--table-header-bg`, `--table-text`
- Adjust full color scales if needed (for Tailwind shades):
  - `--primary-50…950`, `--secondary-50…900`, `--neutral-50…950`
  - Status: `--success-*`, `--warning-*`, `--error-*`

Alpha/Transparency
- Use 8‑digit hex variables already defined in `theme.css` (no HSL triplets):
  - Example: `--muted-a50` (50%), `--primary-a20` (20%), `--border-a10` (10%).
- If you need a new transparency, add a new token, e.g. `--accent-a15: #RRGGBB26`.

Using Colors In Code
- Prefer Tailwind with variables:
  - Backgrounds: `bg-[var(--table-bg)]`, `bg-primary-600`, `bg-card`
  - Text: `text-[var(--table-text)]`, `text-primary-foreground`, `text-muted-foreground`
  - Borders: `border-border`, arbitrary: `border-[var(--border-a30)]`
- Avoid hardcoded `#hex` or `rgb(...)` in TSX/CSS. If needed for special effects, add a new `--fx-*` token to `theme.css` and reference it.

Theme Switching
- Theme is applied by adding a class to `<html>` (`document.documentElement`):
  - Light: no class (default)
  - Dark: `.dark`
  - Modern: `.modern`
- Code: `packages/renderer/src/shell/AppLayout.tsx` manages applying these classes based on user preference.

Glass and Effects
- `.glass-card` is supported and uses the theme’s alpha tokens for subtle blur/opacity.
- If you need different tints in effects, update the `--fx-*` tokens in `theme.css`.

Do’s and Don’ts
- Do: change only variables in `theme.css` to recolor the app.
- Do: use Tailwind classes that map to variables.
- Don’t: add new hex/hsl literals directly in components.
- Don’t: reintroduce per-component color definitions.

Adding Another Theme (optional)
- Create a new scope in `theme.css` like `[data-theme="brandx"] { ... }`.
- Copy the semantic tokens from `:root`, then change the hex values.
- Toggle it by setting `document.documentElement.dataset.theme = 'brandx'`.

