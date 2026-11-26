/**
 * What the sign-in page's right-hand panel shows. A build-time setting beside the app's name
 * (`APP_NAME` in hooks/useAppInfo.ts), because the page renders before anyone is signed in and
 * needs no request for it:
 *
 * - `art: 'rocket'` — the tonal rocket-and-flare drawing (`components/LoginArt.tsx`), coloured
 *   from the rail and flare tokens, so it follows a new brand until someone replaces it.
 * - `art: 'type'` — the app's name and `tagline` set large on the panel, no picture.
 *
 * `tagline` is the one line under the name on the type-only panel. Write it in the product's own
 * words.
 */
export const LOGIN_PANEL: { art: 'rocket' | 'type'; tagline: string } = {
  art: 'rocket',
  tagline: "Your team's work, its knowledge and its agents, in one place.",
}
