import { starterLibrary } from '../../src/data/starterLibrary'
import type { QuizSet, StudyEntry, StudyLibrary } from '../../src/types'
import { defaultTargetLevel, jlptLevels } from '../../src/lib/constants'

type LibraryMetaRow = {
  title: string
  level: string
  updated_at: string
}

type EntryRow = {
  sort_order: number
  entry_json: string
}

type QuizRow = {
  sort_order: number
  quiz_json: string
}

type PersistLibraryOptions = {
  updatedAt?: string
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function normalizeJlptLevel(value: unknown): StudyLibrary['level'] {
  return typeof value === 'string' && jlptLevels.includes(value as StudyLibrary['level'])
    ? (value as StudyLibrary['level'])
    : defaultTargetLevel
}

export function sanitizeLibrary(library: StudyLibrary): StudyLibrary {
  const quizSets = Array.isArray(library.quizSets)
    ? library.quizSets.filter((quizSet) => quizSet.source === 'ai')
    : []

  if (quizSets.length === library.quizSets.length) {
    return library
  }

  return {
    ...library,
    updatedAt: new Date().toISOString(),
    quizSets,
  }
}

function stableLibrary(library: StudyLibrary, updatedAt: string): StudyLibrary {
  const sanitized = sanitizeLibrary(library)

  return {
    ...sanitized,
    title: sanitized.title || starterLibrary.title,
    level: normalizeJlptLevel(sanitized.level),
    updatedAt,
  }
}

function splitEntries(entries: StudyEntry[]) {
  const vocabulary: Array<{ entry: StudyEntry; sortOrder: number }> = []
  const grammar: Array<{ entry: StudyEntry; sortOrder: number }> = []

  entries.forEach((entry, sortOrder) => {
    if (entry.type === 'grammar') {
      grammar.push({ entry, sortOrder })
      return
    }

    vocabulary.push({ entry, sortOrder })
  })

  return { vocabulary, grammar }
}

function serializeEntryStatements(
  db: D1Database,
  userId: string,
  updatedAt: string,
  entries: Array<{ entry: StudyEntry; sortOrder: number }>,
  tableName: 'user_vocabulary_entries' | 'user_grammar_entries',
) {
  return entries.map(({ entry, sortOrder }) =>
    db
      .prepare(
        `INSERT INTO ${tableName} (
          user_id,
          entry_id,
          sort_order,
          term,
          reading,
          meaning,
          item_type,
          source_title,
          updated_at,
          entry_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        entry.id,
        sortOrder,
        entry.term,
        entry.reading ?? null,
        entry.meaning,
        entry.item_type,
        entry.sourceTitle ?? null,
        updatedAt,
        JSON.stringify(entry),
      ),
  )
}

function serializeQuizStatements(db: D1Database, userId: string, updatedAt: string, quizSets: QuizSet[]) {
  return quizSets.map((quizSet, sortOrder) =>
    db
      .prepare(
        `INSERT INTO user_generated_quizzes (
          user_id,
          quiz_id,
          sort_order,
          title,
          model,
          duration_minutes,
          created_at,
          updated_at,
          quiz_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        quizSet.id,
        sortOrder,
        quizSet.title,
        quizSet.model ?? null,
        quizSet.durationMinutes,
        quizSet.createdAt,
        updatedAt,
        JSON.stringify(quizSet),
      ),
  )
}

async function deleteLegacyLibraryRow(db: D1Database, userId: string) {
  await db.prepare('DELETE FROM user_libraries WHERE user_id = ?').bind(userId).run()
}

async function readLegacyLibrary(db: D1Database, userId: string) {
  const row = await db
    .prepare('SELECT library_json FROM user_libraries WHERE user_id = ?')
    .bind(userId)
    .first<{ library_json: string }>()

  if (!row?.library_json) {
    return null
  }

  return parseJson<StudyLibrary>(row.library_json)
}

export async function replaceUserLibrary(
  db: D1Database,
  userId: string,
  library: StudyLibrary,
  options: PersistLibraryOptions = {},
) {
  const updatedAt = options.updatedAt ?? new Date().toISOString()
  const nextLibrary = stableLibrary(library, updatedAt)
  const { vocabulary, grammar } = splitEntries(nextLibrary.entries)
  const statements = [
    db
      .prepare(
        `INSERT INTO user_library_meta (user_id, title, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           title = excluded.title,
           level = excluded.level,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, nextLibrary.title, nextLibrary.level, updatedAt, updatedAt),
    db.prepare('DELETE FROM user_vocabulary_entries WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM user_grammar_entries WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM user_generated_quizzes WHERE user_id = ?').bind(userId),
    ...serializeEntryStatements(db, userId, updatedAt, vocabulary, 'user_vocabulary_entries'),
    ...serializeEntryStatements(db, userId, updatedAt, grammar, 'user_grammar_entries'),
    ...serializeQuizStatements(db, userId, updatedAt, nextLibrary.quizSets),
  ]

  await db.batch(statements)

  return nextLibrary
}

export async function seedStarterLibrary(db: D1Database, userId: string, updatedAt?: string) {
  return replaceUserLibrary(db, userId, starterLibrary, { updatedAt })
}

export async function prependLibraryEntry(
  db: D1Database,
  userId: string,
  entry: StudyEntry,
  options: PersistLibraryOptions = {},
) {
  const currentLibrary = await loadUserLibrary(db, userId)
  const nextEntries = [entry, ...currentLibrary.entries.filter((item) => item.id !== entry.id)]

  return replaceUserLibrary(
    db,
    userId,
    {
      ...currentLibrary,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      entries: nextEntries,
    },
    options,
  )
}

export async function replaceLibraryEntryIfPresent(
  db: D1Database,
  userId: string,
  entry: StudyEntry,
  options: PersistLibraryOptions = {},
) {
  const currentLibrary = await loadUserLibrary(db, userId)
  const entryIndex = currentLibrary.entries.findIndex((item) => item.id === entry.id)

  if (entryIndex === -1) {
    return null
  }

  const nextEntries = currentLibrary.entries.map((item, index) => (index === entryIndex ? entry : item))

  return replaceUserLibrary(
    db,
    userId,
    {
      ...currentLibrary,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      entries: nextEntries,
    },
    options,
  )
}

export async function loadUserLibrary(db: D1Database, userId: string) {
  const [meta, vocabularyRows, grammarRows, quizRows] = await Promise.all([
    db
      .prepare('SELECT title, level, updated_at FROM user_library_meta WHERE user_id = ?')
      .bind(userId)
      .first<LibraryMetaRow>(),
    db
      .prepare('SELECT sort_order, entry_json FROM user_vocabulary_entries WHERE user_id = ? ORDER BY sort_order ASC')
      .bind(userId)
      .all<EntryRow>(),
    db
      .prepare('SELECT sort_order, entry_json FROM user_grammar_entries WHERE user_id = ? ORDER BY sort_order ASC')
      .bind(userId)
      .all<EntryRow>(),
    db
      .prepare('SELECT sort_order, quiz_json FROM user_generated_quizzes WHERE user_id = ? ORDER BY sort_order ASC')
      .bind(userId)
      .all<QuizRow>(),
  ])

  const vocabularyResults = vocabularyRows.results ?? []
  const grammarResults = grammarRows.results ?? []
  const quizResults = quizRows.results ?? []
  const hasNormalizedData =
    Boolean(meta) ||
    vocabularyResults.length > 0 ||
    grammarResults.length > 0 ||
    quizResults.length > 0

  if (hasNormalizedData) {
    const entries = [...vocabularyResults, ...grammarResults]
      .sort((left, right) => left.sort_order - right.sort_order)
      .map((row) => parseJson<StudyEntry>(row.entry_json))
      .filter((entry): entry is StudyEntry => Boolean(entry))
    const quizSets = quizResults
      .map((row) => parseJson<QuizSet>(row.quiz_json))
      .filter((quizSet): quizSet is QuizSet => Boolean(quizSet))

    return stableLibrary(
      {
        title: meta?.title ?? starterLibrary.title,
        level: normalizeJlptLevel(meta?.level),
        updatedAt: meta?.updated_at ?? starterLibrary.updatedAt,
        entries,
        quizSets,
      },
      meta?.updated_at ?? starterLibrary.updatedAt,
    )
  }

  const legacyLibrary = await readLegacyLibrary(db, userId)

  if (legacyLibrary) {
    const migrated = await replaceUserLibrary(db, userId, legacyLibrary, {
      updatedAt: legacyLibrary.updatedAt || new Date().toISOString(),
    })
    await deleteLegacyLibraryRow(db, userId)
    return migrated
  }

  return stableLibrary(starterLibrary, starterLibrary.updatedAt)
}
