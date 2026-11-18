/**
 * The server half of an entity type for knowledge facts (D43): what an app (`./entity-types.ts`)
 * or a plugin (`ServerPlugin.knowledgeEntityTypes`) registers so extraction can attach facts to
 * its rows.
 *
 * **A leaf, types only.** `plugins/types.ts` imports this for the `ServerPlugin` field and
 * `@/plugins/api` re-exports it, so it must reach no barrel: drizzle and shared TYPES, and the
 * `Database` / `AccessScope` types, nothing evaluated. The composer that reads the plugin barrel is
 * `./registry.ts`; the default resolver is `./resolve.ts`.
 */
import type {
  EntityCandidate,
  EntityFactsSchema,
  EntityTypeDeclaration,
} from '@rocketflare/shared/ai/knowledge-facts'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { Database } from '../../../db/client'
import type { AccessScope } from '../access-sql'

/** What a resolver is given besides the mention: a database and WHOSE tenant (and reader) it is. */
export interface EntityResolveScope {
  db: Database
  /** The tenant is `access.tenantId` — a resolver never takes one from anywhere else. */
  access: AccessScope
  /** At most this many candidates, best first. */
  limit: number
}

/**
 * Maps a mention ("Brightside", "order 1042") to candidate rows of the type, best first, every
 * one in `scope.access.tenantId`. Scores are in [0, 1]; extraction links only above its threshold.
 */
export type EntityResolver = (
  name: string,
  scope: EntityResolveScope
) => Promise<readonly EntityCandidate[]>

/**
 * One registered entity type.
 *
 * - `type` / `label` / `facts` — the shared declaration (`EntityTypeDeclaration`): a plugin's
 *   type is `<plugin id>.<name>`, an app's is a bare snake_case name (no dot).
 * - `table` — the domain table its rows live in. **Optional**: a type with no table exists only as
 *   staging entities (`knowledge_entities`) until a person promotes one somewhere.
 * - `idColumn` (default the table's `id`), `labelColumn` (what a row is called — required for
 *   the default resolver), `aliasColumns` (`text` or `text[]` columns that also name it) — column
 *   OBJECTS of `table`, never strings, so the default resolver renders quoted identifiers drizzle
 *   built and never text from a registration. The table must have a `tenantId` column.
 * - `resolve` — replaces the default (trigram similarity over label + aliases, tenant-filtered)
 *   when a type needs its own matching ("order 1042" → the order NUMBER column).
 */
export interface EntityTypeRegistration<F extends EntityFactsSchema = EntityFactsSchema>
  extends EntityTypeDeclaration<F> {
  table?: PgTable
  idColumn?: AnyPgColumn
  labelColumn?: AnyPgColumn
  aliasColumns?: readonly AnyPgColumn[]
  resolve?: EntityResolver
}
