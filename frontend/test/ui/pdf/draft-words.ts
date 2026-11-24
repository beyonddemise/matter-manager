import type { DraftWords } from '../../../src/ui/pdf/draft-words.js'

/** English stand-ins for the words a draft is printed with (#358). */
export const DRAFTS: DraftWords = {
  marked: (name) => `Draft: ${name}`,
  untitled: 'Untitled draft',
  noSetupCode: 'No setup code yet',
}
