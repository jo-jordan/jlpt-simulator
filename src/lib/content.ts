import type {
  ClozeSelectQuestion,
  EntryType,
  ExamPreset,
  ExamSession,
  IncorrectQuestionRecord,
  JlptAnswerFormat,
  JlptLevel,
  JlptSection,
  JlptSourceType,
  JlptSubsection,
  OrderSelectQuestion,
  QuizQuestion,
  QuizSet,
  QuizResultRecord,
  SessionAnswer,
  SingleSelectQuestion,
  StudyEntry,
  StudyLibrary,
} from '../types'
import { createEntryId, createQuizSetId, createResultRecordId, defaultTargetLevel, jlptLevels } from './constants'

export const STORAGE_KEY = 'jlpt-simulator-library'
export const SETTINGS_KEY = 'jlpt-simulator-openai-settings'
export const RESULTS_KEY = 'jlpt-simulator-result-records'

const vocabularyItemTypes = ['漢字読み', '表記', '語形成', '文脈規定', '言い換え類義', '用法']
const grammarItemTypes = ['文の文法1', '文の文法2', '文章の文法']

function pickItemType(type: EntryType, seed: string) {
  const list = type === 'grammar' ? grammarItemTypes : vocabularyItemTypes
  const hash = Array.from(seed).reduce((total, char) => total + char.charCodeAt(0), 0)
  return list[hash % list.length]
}

function normalizeJlptLevel(value: unknown): JlptLevel {
  return typeof value === 'string' && jlptLevels.includes(value as JlptLevel)
    ? (value as JlptLevel)
    : defaultTargetLevel
}

function normalizeComparableText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '')
    .toLowerCase()
}

function hasDuplicateChoices(choices: string[]) {
  const seen = new Set<string>()

  for (const choice of choices) {
    const normalized = normalizeComparableText(choice)

    if (!normalized || seen.has(normalized)) {
      return true
    }

    seen.add(normalized)
  }

  return false
}

function containsExactChoiceText(haystack: string, choice: string) {
  const normalizedChoice = normalizeComparableText(choice)

  if (!normalizedChoice) {
    return false
  }

  return normalizeComparableText(haystack).includes(normalizedChoice)
}

function longestCommonSubstringLength(left: string, right: string) {
  const normalizedLeft = normalizeComparableText(left)
  const normalizedRight = normalizeComparableText(right)

  if (!normalizedLeft || !normalizedRight) {
    return 0
  }

  const dp = new Array(normalizedRight.length + 1).fill(0)
  let maxLength = 0

  for (let leftIndex = 1; leftIndex <= normalizedLeft.length; leftIndex += 1) {
    let previous = 0

    for (let rightIndex = 1; rightIndex <= normalizedRight.length; rightIndex += 1) {
      const current = dp[rightIndex]

      if (normalizedLeft[leftIndex - 1] === normalizedRight[rightIndex - 1]) {
        dp[rightIndex] = previous + 1
        maxLength = Math.max(maxLength, dp[rightIndex])
      } else {
        dp[rightIndex] = 0
      }

      previous = current
    }
  }

  return maxLength
}

function hasObviousGrammarChoiceLeak(target: string, choices: string[], correctIndex: number) {
  const normalizedTarget = normalizeComparableText(target)

  if (normalizedTarget.length < 4) {
    return false
  }

  const overlapScores = choices.map((choice) => longestCommonSubstringLength(normalizedTarget, choice) / normalizedTarget.length)
  const correctOverlap = overlapScores[correctIndex] ?? 0
  const strongestDistractorOverlap = overlapScores.reduce((max, score, index) => {
    if (index === correctIndex) {
      return max
    }

    return Math.max(max, score)
  }, 0)

  return correctOverlap >= 0.6 && strongestDistractorOverlap < 0.4
}

function extractQuotedTarget(prompt: string) {
  const match = prompt.match(/[「『]([^「」『』]+)[」』]/u)
  return match?.[1]?.trim() || ''
}

function buildEntryLookup(entries: StudyEntry[]) {
  return {
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    byTerm: new Map(entries.map((entry) => [entry.term, entry])),
  }
}

function resolveQuestionEntry(
  question: Pick<QuizQuestion, 'sourceEntryId' | 'targetExpression'>,
  entryLookup?: ReturnType<typeof buildEntryLookup>,
) {
  if (!entryLookup) {
    return undefined
  }

  if (question.sourceEntryId && entryLookup.byId.has(question.sourceEntryId)) {
    return entryLookup.byId.get(question.sourceEntryId)
  }

  const quotedTarget = question.targetExpression?.trim() || ''

  if (!quotedTarget) {
    return undefined
  }

  return entryLookup.byTerm.get(quotedTarget)
}

function normalizeSessionAnswerValue(value: unknown): SessionAnswer | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }

  if (Array.isArray(value)) {
    const fragments = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return fragments.length ? fragments : undefined
  }

  return undefined
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
    level: defaultTargetLevel,
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

export function normalizeEntry(raw: Partial<StudyEntry>, sourceTitle?: string): StudyEntry | null {
  const status = raw.status === 'pending' || raw.status === 'failed' ? raw.status : undefined

  if (!raw.term || (!status && !raw.meaning?.trim())) {
    return null
  }

  const type = raw.type === 'grammar' ? 'grammar' : 'vocabulary'
  const defaults = getSchemaDefaults(type, raw.term, raw.example)

  return {
    id: raw.id ?? createEntryId(),
    ...defaults,
    level: normalizeJlptLevel(raw.level),
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

function normalizeQuestion(
  raw: Record<string, unknown>,
  entryLookup?: ReturnType<typeof buildEntryLookup>,
): QuizQuestion | null {
  const legacyPrompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  const rawTargetExpression = typeof raw.targetExpression === 'string' ? raw.targetExpression.trim() : ''
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : ''
  const sourceEntryId = typeof raw.sourceEntryId === 'string' ? raw.sourceEntryId.trim() : undefined
  const section = raw.section === 'grammar' || raw.section === 'vocabulary' ? raw.section : 'mixed'
  const itemType = typeof raw.itemType === 'string' ? raw.itemType.trim() : undefined
  const jlptSection =
    raw.jlptSection === 'language_knowledge' || raw.jlptSection === 'reading' || raw.jlptSection === 'listening'
      ? raw.jlptSection
      : undefined
  const kind = raw.kind

  if (!explanation) {
    return null
  }

  const sourceEntry =
    sourceEntryId && entryLookup?.byId.has(sourceEntryId) ? entryLookup.byId.get(sourceEntryId) : undefined
  const targetExpression = rawTargetExpression || sourceEntry?.term || extractQuotedTarget(legacyPrompt)

  if (kind === 'single_select') {
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : ''
    const choices = Array.isArray(raw.choices) ? raw.choices.filter((item): item is string => typeof item === 'string') : []
    const correctIndex = typeof raw.correctIndex === 'number' ? raw.correctIndex : -1

    if (choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length || hasDuplicateChoices(choices)) {
      return null
    }

    if ((targetExpression && containsExactChoiceText(targetExpression, choices[correctIndex])) || (sentence && containsExactChoiceText(sentence, choices[correctIndex]))) {
      return null
    }

    const question: SingleSelectQuestion = {
      id: typeof raw.id === 'string' ? raw.id : createEntryId(),
      ...(sourceEntryId ? { sourceEntryId } : {}),
      ...(targetExpression ? { targetExpression } : {}),
      kind: 'single_select',
      section,
      itemType,
      jlptSection,
      ...(sentence ? { sentence } : {}),
      choices,
      correctIndex,
      explanation,
    }

    const resolvedEntry = resolveQuestionEntry(question, entryLookup)
    const sourceReading = resolvedEntry?.reading ? normalizeComparableText(resolvedEntry.reading) : ''
    const grammarTarget = resolvedEntry?.term || targetExpression
    const isGrammarChoiceQuestion = section === 'grammar' || itemType === '文の文法1' || itemType === '文の文法2'

    if (
      itemType === '言い換え類義' &&
      sourceReading &&
      choices.some((choice) => normalizeComparableText(choice) === sourceReading)
    ) {
      return null
    }

    if (isGrammarChoiceQuestion && grammarTarget && hasObviousGrammarChoiceLeak(grammarTarget, choices, correctIndex)) {
      return null
    }

    return question
  }

  if (kind === 'cloze_select') {
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : ''
    const choices = Array.isArray(raw.choices) ? raw.choices.filter((item): item is string => typeof item === 'string') : []
    const correctIndex = typeof raw.correctIndex === 'number' ? raw.correctIndex : -1
    const blankCount = sentence.match(/＿+/gu)?.length ?? 0

    if (!sentence || choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length || blankCount !== 1 || hasDuplicateChoices(choices)) {
      return null
    }

    if (containsExactChoiceText(sentence.replace(/＿+/gu, ''), choices[correctIndex])) {
      return null
    }

    const question: ClozeSelectQuestion = {
      id: typeof raw.id === 'string' ? raw.id : createEntryId(),
      ...(sourceEntryId ? { sourceEntryId } : {}),
      ...(targetExpression ? { targetExpression } : {}),
      kind: 'cloze_select',
      section,
      itemType,
      jlptSection,
      sentence,
      choices,
      correctIndex,
      explanation,
    }

    const resolvedEntry = resolveQuestionEntry(question, entryLookup)
    const grammarTarget = resolvedEntry?.term || targetExpression
    const isGrammarChoiceQuestion = section === 'grammar' || itemType === '文の文法1' || itemType === '文の文法2'

    if (isGrammarChoiceQuestion && grammarTarget && hasObviousGrammarChoiceLeak(grammarTarget, choices, correctIndex)) {
      return null
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
      ...(sourceEntryId ? { sourceEntryId } : {}),
      ...(targetExpression ? { targetExpression } : {}),
      kind: 'order_select',
      section,
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

function normalizeQuizSet(
  raw: Record<string, unknown>,
  entryLookup?: ReturnType<typeof buildEntryLookup>,
): QuizSet | null {
  if (raw.source === 'local') {
    return null
  }

  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map((question) => normalizeQuestion(question as Record<string, unknown>, entryLookup))
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

function aiQuizSetsOnly(quizSets: QuizSet[], entries: StudyEntry[] = []) {
  const entryLookup = buildEntryLookup(entries)

  return quizSets
    .map((quizSet) => normalizeQuizSet(quizSet as unknown as Record<string, unknown>, entryLookup))
    .filter((quizSet): quizSet is QuizSet => Boolean(quizSet))
}

function normalizeIncorrectQuestionRecord(raw: Record<string, unknown>): IncorrectQuestionRecord | null {
  const questionNumber =
    typeof raw.questionNumber === 'number' && Number.isInteger(raw.questionNumber) && raw.questionNumber > 0
      ? raw.questionNumber
      : -1
  const question =
    raw.question && typeof raw.question === 'object'
      ? normalizeQuestion(raw.question as Record<string, unknown>)
      : null
  const userAnswer = normalizeSessionAnswerValue(raw.userAnswer)

  if (questionNumber < 0 || !question) {
    return null
  }

  return {
    questionNumber,
    question,
    ...(userAnswer !== undefined ? { userAnswer } : {}),
  }
}

export function normalizeResultRecord(raw: Record<string, unknown>): QuizResultRecord | null {
  const submittedAt = typeof raw.submittedAt === 'string' ? raw.submittedAt : ''
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : ''
  const durationMs = typeof raw.durationMs === 'number' && raw.durationMs >= 0 ? raw.durationMs : -1
  const answeredCount = typeof raw.answeredCount === 'number' && raw.answeredCount >= 0 ? raw.answeredCount : -1
  const correctCount = typeof raw.correctCount === 'number' && raw.correctCount >= 0 ? raw.correctCount : -1
  const questionCount = typeof raw.questionCount === 'number' && raw.questionCount >= 0 ? raw.questionCount : -1
  const scorePercent = typeof raw.scorePercent === 'number' && raw.scorePercent >= 0 ? raw.scorePercent : -1
  const incorrectQuestions = Array.isArray(raw.incorrectQuestions)
    ? raw.incorrectQuestions
        .map((item) =>
          item && typeof item === 'object' ? normalizeIncorrectQuestionRecord(item as Record<string, unknown>) : null,
        )
        .filter((item): item is IncorrectQuestionRecord => Boolean(item))
    : []

  if (
    typeof raw.id !== 'string' ||
    typeof raw.quizSetId !== 'string' ||
    typeof raw.quizTitle !== 'string' ||
    !submittedAt ||
    !startedAt ||
    durationMs < 0 ||
    answeredCount < 0 ||
    correctCount < 0 ||
    questionCount <= 0 ||
    scorePercent < 0
  ) {
    return null
  }

  return {
    id: raw.id,
    quizSetId: raw.quizSetId,
    quizTitle: raw.quizTitle,
    submittedAt,
    startedAt,
    durationMs,
    answeredCount,
    correctCount,
    questionCount,
    scorePercent,
    incorrectQuestions,
  }
}

export function normalizeResultRecords(raw: unknown): QuizResultRecord[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map((item) => (item && typeof item === 'object' ? normalizeResultRecord(item as Record<string, unknown>) : null))
    .filter((item): item is QuizResultRecord => Boolean(item))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
}

export function mergeResultRecords(...groups: QuizResultRecord[][]) {
  const merged = new Map<string, QuizResultRecord>()

  groups.flat().forEach((record) => {
    if (!merged.has(record.id)) {
      merged.set(record.id, record)
    }
  })

  return Array.from(merged.values()).sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
}

export function buildQuizResultRecord(session: ExamSession): QuizResultRecord {
  const submittedAt = Math.min(session.submittedAt ?? Date.now(), session.endsAt)
  const answeredCount = Object.keys(session.answers).length
  const correctCount = countCorrectAnswers(session.quizSet, session.answers)
  const questionCount = session.quizSet.questions.length
  const scorePercent = questionCount ? Math.round((correctCount / questionCount) * 100) : 0
  const incorrectQuestions = session.quizSet.questions
    .map((question, index) => {
      const userAnswer = session.answers[question.id]

      if (isQuestionCorrect(question, userAnswer)) {
        return null
      }

      return {
        questionNumber: index + 1,
        question,
        ...(userAnswer !== undefined ? { userAnswer } : {}),
      }
    })
    .filter((item): item is IncorrectQuestionRecord => Boolean(item))

  return {
    id: createResultRecordId(),
    quizSetId: session.quizSet.id,
    quizTitle: session.quizSet.title,
    submittedAt: new Date(submittedAt).toISOString(),
    startedAt: new Date(session.startedAt).toISOString(),
    durationMs: Math.max(0, submittedAt - session.startedAt),
    answeredCount,
    correctCount,
    questionCount,
    scorePercent,
    incorrectQuestions,
  }
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
  title = `My JLPT ${defaultTargetLevel} Library`,
  quizSets: QuizSet[] = [],
  level: JlptLevel = defaultTargetLevel,
): StudyLibrary {
  return {
    title,
    level,
    updatedAt: new Date().toISOString(),
    entries,
    quizSets: aiQuizSetsOnly(quizSets, entries),
  }
}

export function sanitizeLibrary(library: StudyLibrary): StudyLibrary {
  const quizSets = aiQuizSetsOnly(library.quizSets, library.entries)

  const hasChanged =
    quizSets.length !== library.quizSets.length ||
    quizSets.some((quizSet, index) => {
      const currentQuizSet = library.quizSets[index]
      return !currentQuizSet || currentQuizSet.id !== quizSet.id || currentQuizSet.questions.length !== quizSet.questions.length
    })

  if (!hasChanged) {
    return library
  }

  return {
    ...library,
    updatedAt: new Date().toISOString(),
    quizSets,
  }
}

export function parseLibraryJson(text: string, fallbackTitle = `My JLPT ${defaultTargetLevel} Library`): StudyLibrary {
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
  const entries = rawEntries
    .map((entry) => normalizeEntry(entry, fallbackTitle))
    .filter((entry): entry is StudyEntry => Boolean(entry))
  const entryLookup = buildEntryLookup(entries)

  return {
    title:
      !Array.isArray(parsed) && typeof parsed.title === 'string' ? parsed.title : fallbackTitle,
    level: !Array.isArray(parsed) ? normalizeJlptLevel(parsed.level) : defaultTargetLevel,
    updatedAt: new Date().toISOString(),
    entries,
    quizSets: rawQuizSets
      .map((quizSet) => normalizeQuizSet(quizSet as unknown as Record<string, unknown>, entryLookup))
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
  const nextQuizSets = [quizSet, ...aiQuizSetsOnly(library.quizSets, library.entries).filter((item) => item.id !== quizSet.id)]

  return {
    ...library,
    updatedAt: new Date().toISOString(),
    quizSets: nextQuizSets,
  }
}
