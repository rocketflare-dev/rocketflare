import type { LoginPanelArt } from '@rocketflare/shared/branding'

/**
 * The sign-in panel's FALLBACK: what it shows before `/api/health` answers, or when the deployment
 * sets no `LOGIN_PANEL_ART` / `APP_TAGLINE` in `[vars]` (as `APP_NAME` in hooks/useAppInfo.ts is
 * for the name). Change the deployment's vars, not this file:
 *
 * - `art: 'rocket'` — the tonal rocket-and-flare drawing (`components/LoginArt.tsx`), coloured
 *   from the rail and flare tokens, so it follows a new brand until someone replaces it.
 * - `art: 'type'` — the app's name and `tagline` set large on the panel, no picture.
 *
 * `tagline` is the one line under the name on the type-only panel. Write it in the product's own
 * words.
 */
export const LOGIN_PANEL: { art: LoginPanelArt; tagline: string } = {
  art: 'rocket',
  tagline: "Your team's work, its knowledge and its agents, in one place.",
}
