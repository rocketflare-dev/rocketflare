/**
 * The eval kit compiles `apps/web/src` through the `@/*` alias, and a plugin's UI may import a
 * stylesheet for its side effects (`import './theme.css'`). `apps/web` gets this from
 * `vite/client`; the eval kit has no Vite, so it declares the one shape it meets. Without it,
 * TypeScript 7 refuses the import (TS2882, `noUncheckedSideEffectImports` is on by default).
 */
declare module '*.css'
