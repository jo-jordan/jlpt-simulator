import type {
  ClozeSelectQuestion,
  EntryType,
  ExamPreset,
  JlptAnswerFormat,
  JlptSection,
  JlptSourceType,
  JlptSubsection,
  OrderSelectQuestion,
  QuizQuestion,
  QuizSet,
  SessionAnswer,
  SingleSelectQuestion,
  StudyEntry,
  StudyLibrary,
} from '../types'
import { createEntryId, createQuizSetId } from './constants'

export const STORAGE_KEY = 'jlpt-simulator-library'
export const SETTINGS_KEY = 'jlpt-simulator-openai-settings'

const vocabularyItemTypes = ['漢字読み', '表記', '語形成', '文脈規定', '言い換え類義', '用法']
const grammarItemTypes = ['文の文法1', '文の文法2', '文章の文法']

function pickItemType(type: EntryType, seed: string) {
  const list = type === 'grammar' ? grammarItemTypes : vocabularyItemTypes
  const hash = Array.from(seed).reduce((total, char) => total + char.charCodeAt(0), 0)
  return list[hash % list.length]
}

function getSchemaDefaults(type: EntryType, term: string, example?: string) {
  const section: JlptSection = 'language_knowledge'
  const subsection: JlptSubsection = type
  const answer_format: JlptAnswerFormat = 'single_choice'
  const source_type: JlptSourceType = 'original'
  const item_type = pickItemType(type, term)
  const instructions_ja =
    type === 'grammar' ? '文法として最も適切なものを選んでください。' : '語彙として最も適切なものを選んでください。'
  const instructions_zh =
    type === 'grammar' ? '请选择最合适的语法项目。' : '请选择最合适的词汇项目。'

  return {
    level: 'N2' as const,
    section,
    subsection,
    item_type,
    source_type,
    title: null,
    instructions_ja,
    instructions_zh,
    passage: {
      text: example || null,
      segments: example ? [example] : [],
      metadata: {},
    },
    question: {
      stem: term,
      blank_positions: [],
      choices: [],
      correct_choice_id: null,
      correct_answers: [],
      answer_format,
    },
    audio: {
      audio_id: null,
      transcript: null,
      speaker_notes: [],
      play_limit: 1,
    },
    explanation: {
      ja: null,
      zh: null,
      grammar_points: type === 'grammar' ? [term] : [],
      vocab_points: type === 'vocabulary' ? [term] : [],
    },
    tags: [],
    difficulty: 'medium' as const,
    estimated_time_sec: type === 'grammar' ? 75 : 45,
  }
}

export const examPresets: ExamPreset[] = [
  {
    id: 'full',
    label: 'Full Mock',
    description: 'A longer N2-style language knowledge session.',
    durationMinutes: 105,
    vocabularyCount: 12,
    grammarCount: 12,
  },
  {
    id: 'focus',
    label: 'Focused Sprint',
    description: 'A medium set for daily deliberate practice.',
    durationMinutes: 25,
    vocabularyCount: 6,
    grammarCount: 6,
  },
  {
    id: 'quick',
    label: 'Quick Check',
    description: 'A short drill before or after study.',
    durationMinutes: 10,
    vocabularyCount: 4,
    grammarCount: 4,
  },
]

function normalizeEntry(raw: Partial<StudyEntry>, sourceTitle?: string): StudyEntry | null {
  const status = raw.status === 'pending' || raw.status === 'failed' ? raw.status : undefined

  if (!raw.term || (!status && !raw.meaning?.trim())) {
    return null
  }

  const type = raw.type === 'grammar' ? 'grammar' : 'vocabulary'
  const defaults = getSchemaDefaults(type, raw.term, raw.example)

  return {
    id: raw.id ?? createEntryId(),
    ...defaults,
    level: raw.level === 'N2' ? 'N2' : defaults.level,
    section: raw.section ?? defaults.section,
    subsection: raw.subsection ?? defaults.subsection,
    item_type: raw.item_type?.trim() || defaults.item_type,
    source_type: raw.source_type ?? defaults.source_type,
    title: raw.title ?? defaults.title,
    instructions_ja: raw.instructions_ja?.trim() || defaults.instructions_ja,
    instructions_zh: raw.instructions_zh?.trim() || defaults.instructions_zh,
    passage: {
      text: raw.passage?.text ?? defaults.passage.text,
      segments: raw.passage?.segments ?? defaults.passage.segments,
      metadata: raw.passage?.metadata ?? defaults.passage.metadata,
    },
    question: {
      stem: raw.question?.stem?.trim() || raw.term.trim(),
      blank_positions: raw.question?.blank_positions ?? defaults.question.blank_positions,
      choices: raw.question?.choices ?? defaults.question.choices,
      correct_choice_id: raw.question?.correct_choice_id ?? defaults.question.correct_choice_id,
      correct_answers: raw.question?.correct_answers ?? defaults.question.correct_answers,
      answer_format: raw.question?.answer_format ?? defaults.question.answer_format,
    },
    audio: {
      audio_id: raw.audio?.audio_id ?? defaults.audio.audio_id,
      transcript: raw.audio?.transcript ?? defaults.audio.transcript,
      speaker_notes: raw.audio?.speaker_notes ?? defaults.audio.speaker_notes,
      play_limit: raw.audio?.play_limit ?? defaults.audio.play_limit,
    },
    explanation: {
      ja: raw.explanation?.ja ?? defaults.explanation.ja,
      zh: raw.explanation?.zh ?? defaults.explanation.zh,
      grammar_points: raw.explanation?.grammar_points ?? defaults.explanation.grammar_points,
      vocab_points: raw.explanation?.vocab_points ?? defaults.explanation.vocab_points,
    },
    tags: raw.tags?.filter(Boolean) || defaults.tags,
    difficulty: raw.difficulty ?? defaults.difficulty,
    estimated_time_sec: raw.estimated_time_sec ?? defaults.estimated_time_sec,
    type,
    term: raw.term.trim(),
    meaning: raw.meaning?.trim() || '',
    reading: raw.reading?.trim() || undefined,
    example: raw.example?.trim() || undefined,
    notes: raw.notes?.trim() || undefined,
    sourceTitle: raw.sourceTitle ?? sourceTitle,
    status,
    generationError: raw.generationError?.trim() || undefined,
    requestedAt: raw.requestedAt,
    completedAt: raw.completedAt,
  }
}

function normalizeQuestion(raw: Record<string, unknown>): QuizQuestion | null {
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : ''
  const section = raw.section === 'grammar' || raw.section === 'vocabulary' ? raw.section : 'mixed'
  const itemType = typeof raw.itemType === 'string' ? raw.itemType.trim() : undefined
  const jlptSection =
    raw.jlptSection === 'language_knowledge' || raw.jlptSection === 'reading' || raw.jlptSection === 'listening'
      ? raw.jlptSection
      : undefined
  const kind = raw.kind

  if (!prompt || !explanation) {
    return null
  }

  if (kind === 'single_select') {
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : ''
    const choices = Array.isArray(raw.choices) ? raw.choices.filter((item): item is string => typeof item === 'string') : []
    const correctIndex = typeof raw.correctIndex === 'number' ? raw.correctIndex : -1

    if (choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length) {
      return null
    }

    const question: SingleSelectQuestion = {
      id: typeof raw.id === 'string' ? raw.id : createEntryId(),
      kind: 'single_select',
      section,
      prompt,
      itemType,
      jlptSection,
      ...(sentence ? { sentence } : {}),
      choices,
      correctIndex,
      explanation,
    }
    return question
  }

  if (kind === 'cloze_select') {
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : ''
    const choices = Array.isArray(raw.choices) ? raw.choices.filter((item): item is string => typeof item === 'string') : []
    const correctIndex = typeof raw.correctIndex === 'number' ? raw.correctIndex : -1

    if (!sentence || choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length) {
      return null
    }

    const question: ClozeSelectQuestion = {
      id: typeof raw.id === 'string' ? raw.id : createEntryId(),
      kind: 'cloze_select',
      section,
      prompt,
      itemType,
      jlptSection,
      sentence,
      choices,
      correctIndex,
      explanation,
    }
    return question
  }

  if (kind === 'order_select') {
    const fragments = Array.isArray(raw.fragments)
      ? raw.fragments.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    const correctOrder = Array.isArray(raw.correctOrder)
      ? raw.correctOrder.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []

    if (fragments.length < 2 || correctOrder.length !== fragments.length) {
      return null
    }

    const question: OrderSelectQuestion = {
      id: typeof raw.id === 'string' ? raw.id : createEntryId(),
      kind: 'order_select',
      section,
      prompt,
      itemType,
      jlptSection,
      fragments,
      correctOrder,
      explanation,
    }
    return question
  }

  return null
}

function normalizeQuizSet(raw: Record<string, unknown>): QuizSet | null {
  if (raw.source === 'local') {
    return null
  }

  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map((question) => normalizeQuestion(question as Record<string, unknown>))
        .filter((question): question is QuizQuestion => Boolean(question))
    : []

  if (!questions.length) {
    return null
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : createQuizSetId(),
    title: typeof raw.title === 'string' ? raw.title : 'Generated Quiz Set',
    source: 'ai',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    durationMinutes: typeof raw.durationMinutes === 'number' ? raw.durationMinutes : 45,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    questions,
  }
}

function aiQuizSetsOnly(quizSets: QuizSet[]) {
  return quizSets.filter((quizSet) => quizSet.source === 'ai')
}

function parsePipeSeparated(text: string, sourceTitle: string) {
  const entries: StudyEntry[] = []
  let activeType: EntryType = 'vocabulary'

  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line) {
        return
      }

      const lower = line.toLowerCase()

      if (lower.includes('grammar')) {
        activeType = 'grammar'
      } else if (lower.includes('vocab')) {
        activeType = 'vocabulary'
      }

      if (
        lower.startsWith('#') ||
        lower.startsWith('//') ||
        lower === '| type | term | reading | meaning | example | notes |' ||
        /^[-|\s:]+$/.test(line)
      ) {
        return
      }

      const cleaned = line.replace(/^- /, '')
      const parts = cleaned
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean)

      if (parts.length < 2) {
        return
      }

      const startsWithType =
        parts[0].toLowerCase() === 'grammar' || parts[0].toLowerCase() === 'vocabulary'

      const entry = normalizeEntry(
        {
          type: startsWithType ? (parts[0].toLowerCase() as EntryType) : activeType,
          term: startsWithType ? parts[1] : parts[0],
          reading: startsWithType ? parts[2] : parts[1],
          meaning: startsWithType ? parts[3] : parts[2],
          example: startsWithType ? parts[4] : parts[3],
          notes: startsWithType ? parts[5] : parts[4],
        },
        sourceTitle,
      )

      if (entry) {
        entries.push(entry)
      }
    })

  return entries
}

export function createLibrary(
  entries: StudyEntry[],
  title = 'My JLPT N2 Library',
  quizSets: QuizSet[] = [],
): StudyLibrary {
  return {
    title,
    level: 'N2',
    updatedAt: new Date().toISOString(),
    entries,
    quizSets: aiQuizSetsOnly(quizSets),
  }
}

export function sanitizeLibrary(library: StudyLibrary): StudyLibrary {
  const quizSets = aiQuizSetsOnly(library.quizSets)

  if (quizSets.length === library.quizSets.length) {
    return library
  }

  return {
    ...library,
    updatedAt: new Date().toISOString(),
    quizSets,
  }
}

export function parseLibraryJson(text: string, fallbackTitle = 'My JLPT N2 Library'): StudyLibrary {
  const parsed = JSON.parse(text) as
    | StudyLibrary
    | StudyEntry[]
    | { entries?: StudyEntry[]; quizSets?: QuizSet[]; title?: string; level?: string }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : 'entries' in parsed && Array.isArray(parsed.entries)
      ? parsed.entries
      : []
  const rawQuizSets =
    !Array.isArray(parsed) && 'quizSets' in parsed && Array.isArray(parsed.quizSets)
      ? parsed.quizSets
      : []

  return {
    title:
      !Array.isArray(parsed) && typeof parsed.title === 'string' ? parsed.title : fallbackTitle,
    level: !Array.isArray(parsed) && typeof parsed.level === 'string' ? parsed.level : 'N2',
    updatedAt: new Date().toISOString(),
    entries: rawEntries
      .map((entry) => normalizeEntry(entry, fallbackTitle))
      .filter((entry): entry is StudyEntry => Boolean(entry)),
    quizSets: rawQuizSets
      .map((quizSet) => normalizeQuizSet(quizSet as unknown as Record<string, unknown>))
      .filter((quizSet): quizSet is QuizSet => Boolean(quizSet)),
  }
}

export async function importEntriesFromFile(file: File) {
  const sourceTitle = file.name
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.json')) {
    const text = await file.text()
    return parseLibraryJson(text, file.name.replace(/\.json$/i, '')).entries
  }

  if (lowerName.endsWith('.docx')) {
    const mammoth = await import('mammoth')
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })
    return parsePipeSeparated(result.value, sourceTitle)
  }

  return parsePipeSeparated(await file.text(), sourceTitle)
}

export function formatRemainingTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function getEntryCounts(entries: StudyEntry[]) {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.type] += 1
      return counts
    },
    { vocabulary: 0, grammar: 0 },
  )
}

export function isEntryReady(entry: StudyEntry) {
  return !entry.status && entry.term.trim().length > 0 && entry.meaning.trim().length > 0
}

export function countReadyEntries(entries: StudyEntry[]) {
  return entries.filter((entry) => isEntryReady(entry)).length
}

export function isQuestionCorrect(question: QuizQuestion, answer: SessionAnswer | undefined) {
  if (answer === undefined) {
    return false
  }

  if (question.kind === 'order_select') {
    return Array.isArray(answer) && answer.join('||') === question.correctOrder.join('||')
  }

  return typeof answer === 'number' && answer === question.correctIndex
}

export function countCorrectAnswers(quizSet: QuizSet, answers: Record<string, SessionAnswer>) {
  return quizSet.questions.filter((question) => isQuestionCorrect(question, answers[question.id])).length
}

export function upsertQuizSet(library: StudyLibrary, quizSet: QuizSet): StudyLibrary {
  const nextQuizSets = [quizSet, ...aiQuizSetsOnly(library.quizSets).filter((item) => item.id !== quizSet.id)]

  return {
    ...library,
    updatedAt: new Date().toISOString(),
    quizSets: nextQuizSets,
  }
}
