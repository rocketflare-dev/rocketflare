/**
 * The COMPONENTS half of the UI kit (D31) — for a plugin's PAGES, never for its `ui/index.ts`.
 *
 * The split is the whole design. `./ui-wiring` is what the UI entry may import, because that file
 * ships in the main bundle for every reader. This module is what a lazy PAGE imports, because a
 * page ships in its own chunk and only for the people who open it. `uiEntryIssues` in
 * `tests/helpers/plugins.ts` enforces the line, and has since before this module existed.
 *
 * **Everything the kit's own pages use is here on purpose.** All seventeen exports of
 * `components/shared` are re-exported rather than a chosen subset, because the failure mode of a
 * short list is a plugin rebuilding `PaginationControls` or `ConfirmModal` slightly differently —
 * which looks subtly wrong on a page next to a kit one, and is the sort of thing nobody files a
 * bug about.
 *
 * `showToast` is exported once, from here. It is reachable in the kit by two public paths
 * (`components/shared` and a re-export from `lib/api-client`) and one plugin took each — which is
 * how two call sites of the same function come to look like two different functions. One path.
 */

/**
 * The spinner. It sits OUTSIDE `components/shared` in the kit — an accident of ordering rather
 * than a decision, and one every plugin that wanted a loading state had to discover by reading the
 * tree. It is re-exported from the shared barrel now, and from here.
 */
export { LoadingIndicator } from '../../ui/components/LoadingIndicator'
/**
 * The kit's sidebar, for a plugin's own nav TEST.
 *
 * It is here rather than in `./ui-wiring` because it RENDERS — the wiring half must stay weightless,
 * and a plugin's `ui/index.ts` has no business importing a component. What needs it is the test that
 * proves a plugin's nav item obeys the kit's guards: an app on this kit wrote that test against a
 * re-implementation of the guard logic, and the re-implementation is precisely what hid the bug it
 * was meant to catch. Driving the real `SideNav` is the whole value; anything that re-derives what
 * it does is worthless.
 */
export { default as SideNav } from '../../ui/components/SideNav'
export type {
  AccessPickerProps,
  Breadcrumb,
  DocumentCardProps,
  DocumentLinkProps,
  ModalProps,
  TabConfig,
  Toast,
  ToastType,
  VisibilityModalProps,
} from '../../ui/components/shared'
// The seventeen `components/shared` exports, whole.
export {
  AccessBadge,
  AccessPicker,
  AlertModal,
  ConfirmModal,
  DocumentCard,
  DocumentLink,
  documentLinkProps,
  EmptyState,
  EmptyStateCard,
  FieldError,
  fieldErrorFor,
  LogoMark,
  Modal,
  PageHeader,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SectionPanelSkeleton,
  SettingInput,
  SettingRow,
  SettingToggle,
  SkeletonRows,
  showToast,
  ToastContainer,
  URLTabs,
  useToastStore,
  VisibilityModal,
} from '../../ui/components/shared'
/** Who is signed in, what they may do, and which groups they are in. */
export { useAuth, useTenancyMode } from '../../ui/hooks/useAuth'
export { useGroups, useGroupTypes, useMyGroups } from '../../ui/hooks/useGroups'
export { useFeature, usePermissions } from '../../ui/hooks/usePermissions'
export type { ApiRequestOptions } from '../../ui/lib/api-client'
/** Every request goes through this: `credentials: 'include'`, the shared error envelope, and a
 * `schema` option that parses the response with the same contract the server validated with. */
export { ApiError, api } from '../../ui/lib/api-client'
export {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  initials,
  timeAgo,
} from '../../ui/lib/format'
/** A page may also want the wiring vocabulary — a guard on a sub-route, say. */
export type { NavGuard } from './ui-wiring'
