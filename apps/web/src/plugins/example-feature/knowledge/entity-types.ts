/**
 * **A knowledge entity type** (D43): `example-feature.note`, so extraction may attach facts read
 * from documents to this plugin's notes ("the note 'Kitchen refit' — due 3 March, contact Sam").
 *
 * The type is `<plugin id>.<name>`; the table is the plugin's OWN, and `labelColumn` is what the
 * kit's default resolver matches a mention against (trigram similarity, inside the reader's
 * tenant — `tests/api/knowledge-entity-type.test.ts` pins that it never finds another tenant's
 * note). Each fact key is snake_case and its `.describe()` is what the extraction prompt shows the
 * model. The host never writes a fact into `example_notes`: applying one is an approved action.
 */
import { z } from 'zod'
import type { EntityTypeRegistration } from '@/plugins/api'
import { exampleNotes } from '../db/schema/example-notes'

export const EXAMPLE_NOTE_ENTITY_TYPE = 'example-feature.note'

export const exampleNoteEntityType = {
  type: EXAMPLE_NOTE_ENTITY_TYPE,
  label: 'Example note',
  table: exampleNotes,
  labelColumn: exampleNotes.title,
  facts: z.object({
    due_date: z.iso.date().describe('When the work the note describes is due (YYYY-MM-DD)'),
    contact_name: z.string().describe('The person to contact about the note'),
  }),
} satisfies EntityTypeRegistration
