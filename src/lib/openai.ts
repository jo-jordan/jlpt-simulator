import { createEntryId, createQuizSetId, defaultLanguage, defaultOpenAiModels, defaultTargetLevel } from './constants'
import type {
  EntryType,
  JlptSection,
  JlptLevel,
  LanguageCode,
  OpenAiSettings,
  QuizQuestion,
  QuizSet,
  StudyEntry,
} from '../types'

const OPENAI_API_BASE = 'https://api.openai.com/v1'
const vocabularyItemTypes = ['漢字読み', '表記', '語形成', '文脈規定', '言い換え類義', '用法'] as const
const grammarItemTypes = ['文の文法1', '文の文法2', '文章の文法'] as const
const allowedItemTypes = [...vocabularyItemTypes, ...grammarItemTypes] as const
const targetQuestionCount = 12
const minimumQuestionCount = 8
const sourceMaterialLimit = 80
const recentQuizWindow = 6
const recentSourcePenalty = 3

type OpenAiResponse = {
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
  error?: {
    message?: string
  }
}

type RawAiQuestion = Record<string, unknown>
type RawEntryDetails = Record<string, unknown>
type SourceEntryMap = Map<string, Pick<StudyEntry, 'id' | 'term' | 'reading'>>

function outputLanguageLabel(language: LanguageCode) {
  if (language === 'zh-CN') {
    return 'Simplified Chinese'
  }

  if (language === 'ja') {
    return 'Japanese'
  }

  return 'English'
}

function extractOutputText(data: OpenAiResponse) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text
  }

  for (const outputItem of data.output ?? []) {
    for (const contentPart of outputItem.content ?? []) {
      if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
        return contentPart.text
      }
    }
  }

  return ''
}

function isSupportedQuizModel(modelId: string) {
  const normalized = modelId.toLowerCase()

  if (!normalized.startsWith('gpt-')) {
    return false
  }

  return !['audio', 'realtime', 'transcribe', 'tts', 'vision'].some((blocked) =>
    normalized.includes(blocked),
  )
}

function pickQuestionKind(itemType: string) {
  if (itemType === '文脈規定' || itemType === '文の文法2') {
    return 'cloze_select'
  }

  if (itemType === '文章の文法') {
    return 'order_select'
  }

  return 'single_select'
}

function normalizeSentence(value: unknown) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim()
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

function shuffleArray<T>(items: T[]) {
  const next = [...items]

  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[next[index], next[swapIndex]] = [next[swapIndex], next[index]]
  }

  return next
}

function buildQuestionSignature(question: QuizQuestion) {
  const sentence = 'sentence' in question && question.sentence ? question.sentence : ''
  return normalizeComparableText(
    [question.kind, question.itemType ?? '', question.targetExpression ?? '', sentence].join('|'),
  )
}

function collectRecentSourceEntryIds(quizSets: QuizSet[]) {
  return quizSets
    .slice(0, recentQuizWindow)
    .flatMap((quizSet) => quizSet.questions)
    .map((question) => question.sourceEntryId?.trim())
    .filter((sourceEntryId): sourceEntryId is string => Boolean(sourceEntryId))
}

function pickSourceMaterial(entries: StudyEntry[], recentQuizSets: QuizSet[]) {
  const recentSourceEntryIds = collectRecentSourceEntryIds(quizSetsToRecentFirst(recentQuizSets))
  const usageCounts = new Map<string, number>()

  recentSourceEntryIds.forEach((entryId) => {
    usageCounts.set(entryId, (usageCounts.get(entryId) ?? 0) + 1)
  })

  return shuffleArray(entries)
    .sort((left, right) => {
      const leftPenalty = Math.min(usageCounts.get(left.id) ?? 0, recentSourcePenalty)
      const rightPenalty = Math.min(usageCounts.get(right.id) ?? 0, recentSourcePenalty)
      return leftPenalty - rightPenalty
    })
    .slice(0, Math.min(sourceMaterialLimit, entries.length))
}

function quizSetsToRecentFirst(quizSets: QuizSet[]) {
  return [...quizSets].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function finalizeAiQuestions(rawQuestions: Array<Record<string, unknown>>, sourceEntries: SourceEntryMap) {
  const seenSourceEntryIds = new Set<string>()
  const seenSignatures = new Set<string>()
  const questions: QuizQuestion[] = []

  rawQuestions.forEach((question) => {
    const normalized = normalizeAiQuestion(question, sourceEntries)

    if (!normalized) {
      return
    }

    const signature = buildQuestionSignature(normalized)

    if (!signature || seenSignatures.has(signature)) {
      return
    }

    if (normalized.sourceEntryId && seenSourceEntryIds.has(normalized.sourceEntryId)) {
      return
    }

    seenSignatures.add(signature)

    if (normalized.sourceEntryId) {
      seenSourceEntryIds.add(normalized.sourceEntryId)
    }

    questions.push(normalized)
  })

  return shuffleArray(questions)
}

function resolveSourceEntry(
  sourceEntries: SourceEntryMap,
  sourceEntryId: string,
  fallbackTarget = '',
) {
  const direct = sourceEntries.get(sourceEntryId)

  if (direct) {
    return direct
  }

  const quotedTarget = fallbackTarget || ''

  if (!quotedTarget) {
    return undefined
  }

  return Array.from(sourceEntries.values()).find((entry) => entry.term === quotedTarget)
}

function normalizeAiQuestion(question: RawAiQuestion, sourceEntries: SourceEntryMap): QuizQuestion | null {
  const legacyPrompt = typeof question.prompt === 'string' ? question.prompt.trim() : ''
  const explanation = typeof question.explanation === 'string' ? question.explanation.trim() : ''
  const sourceEntryId = typeof question.sourceEntryId === 'string' ? question.sourceEntryId.trim() : ''
  const section: EntryType | 'mixed' =
    question.section === 'grammar' || question.section === 'vocabulary' ? question.section : 'mixed'
  const itemType =
    typeof question.itemType === 'string' && allowedItemTypes.includes(question.itemType as (typeof allowedItemTypes)[number])
      ? question.itemType
      : ''
  const jlptSection: JlptSection =
    question.jlptSection === 'language_knowledge' ||
    question.jlptSection === 'reading' ||
    question.jlptSection === 'listening'
      ? question.jlptSection
      : 'language_knowledge'

  if (!explanation || !itemType || !sourceEntryId) {
    return null
  }

  const targetExpression = sourceEntries.get(sourceEntryId)?.term || extractQuotedTarget(legacyPrompt)
  const sourceEntry = resolveSourceEntry(sourceEntries, sourceEntryId, targetExpression)

  const base = {
    id: createEntryId(),
    sourceEntryId,
    ...(targetExpression ? { targetExpression } : {}),
    section,
    explanation,
    itemType,
    jlptSection,
  }

  const expectedKind = pickQuestionKind(itemType)

  if (expectedKind === 'order_select') {
    const fragments = Array.isArray(question.fragments)
      ? question.fragments.map((item) => String(item).trim()).filter(Boolean)
      : []
    const correctOrder = Array.isArray(question.correctOrder)
      ? question.correctOrder.map((item) => String(item).trim()).filter(Boolean)
      : []

    if (fragments.length < 2 || correctOrder.length !== fragments.length) {
      return null
    }

    return {
      ...base,
      kind: 'order_select',
      fragments,
      correctOrder,
    }
  }

  const choices = Array.isArray(question.choices)
    ? question.choices.map((item) => String(item).trim()).filter(Boolean)
    : []
  const correctIndex =
    typeof question.correctIndex === 'number' && Number.isInteger(question.correctIndex)
      ? question.correctIndex
      : -1

  if (choices.length !== 4 || correctIndex < 0 || correctIndex >= choices.length || hasDuplicateChoices(choices)) {
    return null
  }

  const correctChoice = choices[correctIndex]
  const sourceReading = sourceEntry?.reading ? normalizeComparableText(sourceEntry.reading) : ''
  const grammarTarget = sourceEntry?.term || targetExpression
  const isGrammarChoiceQuestion = section === 'grammar' || itemType === '文の文法1' || itemType === '文の文法2'

  if (isGrammarChoiceQuestion && grammarTarget && hasObviousGrammarChoiceLeak(grammarTarget, choices, correctIndex)) {
    return null
  }

  if (expectedKind === 'cloze_select') {
    const sentence = normalizeSentence(question.sentence)
    const blankCount = sentence.match(/＿+/gu)?.length ?? 0

    if (!sentence || !sentence.includes('＿＿＿') || blankCount !== 1) {
      return null
    }

    if (containsExactChoiceText(sentence.replace(/＿+/gu, ''), correctChoice)) {
      return null
    }

    return {
      ...base,
      kind: 'cloze_select',
      sentence,
      choices,
      correctIndex,
    }
  }

  const sentence = normalizeSentence(question.sentence)

  if (!sentence && !targetExpression) {
    return null
  }

  if ((targetExpression && containsExactChoiceText(targetExpression, correctChoice)) || (sentence && containsExactChoiceText(sentence, correctChoice))) {
    return null
  }

  if (itemType === '言い換え類義' && sourceReading) {
    const hasReadingChoice = choices.some((choice) => normalizeComparableText(choice) === sourceReading)

    if (hasReadingChoice) {
      return null
    }
  }

  return {
    ...base,
    kind: 'single_select',
    ...(sentence ? { sentence } : {}),
    choices,
    correctIndex,
  }
}

function makeQuizSchema() {
  return {
    name: 'jlpt_quiz_set',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'durationMinutes', 'questions'],
      properties: {
        title: { type: 'string' },
        durationMinutes: { type: 'number' },
        questions: {
          type: 'array',
          minItems: minimumQuestionCount,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'kind',
              'section',
              'jlptSection',
              'sourceEntryId',
              'itemType',
              'explanation',
              'sentence',
              'choices',
              'correctIndex',
              'fragments',
              'correctOrder',
            ],
            properties: {
              kind: {
                type: 'string',
                enum: ['single_select', 'cloze_select', 'order_select'],
              },
              section: {
                type: 'string',
                enum: ['vocabulary', 'grammar', 'mixed'],
              },
              sourceEntryId: { type: 'string' },
              jlptSection: {
                type: 'string',
                enum: ['language_knowledge'],
              },
              itemType: {
                type: 'string',
                enum: [...allowedItemTypes],
              },
              explanation: { type: 'string' },
              sentence: { type: ['string', 'null'] },
              choices: {
                type: ['array', 'null'],
                minItems: 4,
                maxItems: 4,
                items: { type: 'string' },
              },
              correctIndex: { type: ['number', 'null'] },
              fragments: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
              correctOrder: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    strict: true,
  }
}

function makeEntryDetailsSchema(type: EntryType) {
  return {
    name: 'jlpt_entry_details',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['reading', 'meaning', 'example', 'notes', 'itemType'],
      properties: {
        reading: { type: ['string', 'null'] },
        meaning: { type: 'string' },
        example: { type: 'string' },
        notes: { type: ['string', 'null'] },
        itemType: {
          type: 'string',
          enum: [...(type === 'grammar' ? grammarItemTypes : vocabularyItemTypes)],
        },
      },
    },
    strict: true,
  }
}

function normalizeAiEntryDetails(type: EntryType, details: RawEntryDetails) {
  const meaning = typeof details.meaning === 'string' ? details.meaning.trim() : ''
  const example = typeof details.example === 'string' ? details.example.trim() : ''
  const reading = typeof details.reading === 'string' ? details.reading.trim() : ''
  const notes = typeof details.notes === 'string' ? details.notes.trim() : ''
  const itemTypeChoices: readonly string[] = type === 'grammar' ? grammarItemTypes : vocabularyItemTypes
  const itemType =
    typeof details.itemType === 'string' && itemTypeChoices.includes(details.itemType)
      ? details.itemType
      : ''

  if (!meaning || !example || !itemType) {
    return null
  }

  return {
    reading: reading || null,
    meaning,
    example,
    notes: notes || null,
    itemType,
  }
}

async function requestStructuredOutput<T>({
  apiKey,
  model,
  instructions,
  input,
  schema,
}: {
  apiKey: string
  model: string
  instructions: string
  input: string
  schema: ReturnType<typeof makeQuizSchema> | ReturnType<typeof makeEntryDetailsSchema>
}): Promise<T> {
  const attemptBodies = [
    {
      model,
      instructions,
      input,
      reasoning_effort: 'low',
      text: {
        format: {
          type: 'json_schema',
          ...schema,
        },
      },
    },
    {
      model,
      instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          ...schema,
        },
      },
    },
  ]

  let response: Response | null = null
  let data: OpenAiResponse = {}

  for (const body of attemptBodies) {
    response = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    data = (await response.json()) as OpenAiResponse

    if (response.ok) {
      break
    }

    const message = data.error?.message || ''
    const shouldRetry =
      response.status === 400 &&
      (message.includes('reasoning') ||
        message.includes('Unsupported parameter') ||
        message.includes('Unknown parameter'))

    if (!shouldRetry) {
      break
    }
  }

  if (!response?.ok) {
    throw new Error(data.error?.message || 'OpenAI request failed.')
  }

  const outputText = extractOutputText(data)

  if (!outputText) {
    throw new Error('OpenAI did not return structured content.')
  }

  return JSON.parse(outputText) as T
}

export async function fetchOpenAiModels(apiKey: string) {
  const response = await fetch(`${OPENAI_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  const data = (await response.json()) as { data?: Array<{ id: string }>; error?: { message?: string } }

  if (!response.ok) {
    throw new Error(data.error?.message || 'Unable to fetch models from OpenAI.')
  }

  const availableModels = (data.data ?? [])
    .map((item) => item.id)
    .filter((id) => isSupportedQuizModel(id))
    .sort((left, right) => left.localeCompare(right))

  return availableModels.length ? availableModels : defaultOpenAiModels
}

export async function generateAiQuizSet({
  apiKey,
  model,
  entries,
  durationMinutes,
  recentQuizSets = [],
  targetLevel,
}: {
  apiKey: string
  model: string
  entries: StudyEntry[]
  durationMinutes: number
  recentQuizSets?: QuizSet[]
  targetLevel: JlptLevel
}): Promise<QuizSet> {
  const selectedEntries = pickSourceMaterial(entries, recentQuizSets)
  const sourceEntries = new Map(
    selectedEntries.map((entry) => [
      entry.id,
      {
        id: entry.id,
        term: entry.term,
        reading: entry.reading,
      },
    ]),
  )
  const trimmedEntries = selectedEntries.map((entry) => ({
    id: entry.id,
    section: entry.section,
    subsection: entry.subsection,
    item_type: entry.item_type,
    type: entry.type,
    term: entry.term,
    reading: entry.reading,
    meaning: entry.meaning,
    example: entry.example,
    notes: entry.notes,
  }))

  const instructions = [
    `Generate a realistic JLPT ${targetLevel} language knowledge quiz set.`,
    'Use only the provided source material. Do not invent grammar points or vocabulary outside the input.',
    `Match the real JLPT ${targetLevel} forms and difficulty instead of generic quiz styles.`,
    'When multiple valid quiz sets are possible, vary the selected source entries, item-type order, and final question order instead of repeating the same pattern every time.',
    'Write every quiz field in natural Japanese, including title, explanation, sentence, choices, fragments, and correctOrder.',
    'Do not output English or Chinese in any quiz field.',
    'Use these mappings strictly:',
    '- 漢字読み, 表記, 語形成, 言い換え類義, 用法, 文の文法1 => kind=single_select',
    '- 文脈規定, 文の文法2 => kind=cloze_select',
    '- 文章の文法 => kind=order_select',
    'Every question object must include every schema key. Use null for fields that do not apply.',
    'Every question must include sourceEntryId set to the id of the source_material entry it is based on.',
    'Use each sourceEntryId at most once in a generated set unless there is clearly not enough material.',
    'Do not include a prompt field in any question object.',
    'For single_select, the question must be answerable from the output alone. Include a natural Japanese sentence in sentence, or rely on sourceEntryId for direct target-expression questions like meaning or reading.',
    'For cloze_select, include exactly one blank shown as ＿＿＿ in sentence.',
    'For single_select and cloze_select, provide exactly 4 choices and a zero-based correctIndex.',
    'For single_select, the correct choice must be a paraphrase, definition, or interpretation, not the same surface form as the target expression shown by sourceEntryId or sentence.',
    'Do not place the exact correct choice text verbatim in sentence for single_select.',
    'For 文の文法1 and 文の文法2, distractors must be plausible competing grammar forms for the same sentence slot. Do not use random fragments, isolated endings, or obviously unrelated words.',
    'If a grammar target pattern like 「ざるを得ない」 is identified by sourceEntryId, do not make the correct choice the only option that visibly reuses that pattern.',
    'For 言い換え類義, choices must be semantic paraphrases or near-synonyms in Japanese. Never use the target reading, kana transcription, pronunciation guide, or spelling-only variant as any choice.',
    'For cloze_select, the correct choice must only fit the blank and must not already appear elsewhere in sentence.',
    'For order_select, fragments and correctOrder must contain the same strings in different order.',
    'For single_select and cloze_select, set fragments=null and correctOrder=null.',
    'For cloze_select, sentence must be a string and choices/correctIndex must be non-null.',
    'For single_select, choices/correctIndex must be non-null. sentence may be null only when sourceEntryId clearly identifies the target expression.',
    'For order_select, set sentence=null, choices=null, and correctIndex=null.',
    `Keep Japanese natural, concise, and close to real JLPT ${targetLevel} wording.`,
    'Avoid duplicate stems, duplicate answers, and obvious distractors.',
    'Set jlptSection to language_knowledge for every question.',
  ].join('\n')

  const input = JSON.stringify({
    target_level: targetLevel,
    target_duration_minutes: durationMinutes,
    variation_seed: createEntryId(),
    question_count_target: targetQuestionCount,
    minimum_question_count: minimumQuestionCount,
    recent_source_entry_ids_to_avoid_when_possible: collectRecentSourceEntryIds(
      quizSetsToRecentFirst(recentQuizSets),
    ),
    source_material: trimmedEntries,
    item_type_distribution_hint: {
      vocabulary: [...vocabularyItemTypes],
      grammar: [...grammarItemTypes],
    },
  })

  const parsed = await requestStructuredOutput<{
    title: string
    durationMinutes: number
    questions: Array<Record<string, unknown>>
  }>({
    apiKey,
    model,
    instructions,
    input,
    schema: makeQuizSchema(),
  })

  const questions = finalizeAiQuestions(parsed.questions, sourceEntries)

  const quizSet: QuizSet = {
    id: createQuizSetId(),
    title: parsed.title || `AI生成 ${targetLevel} セット`,
    source: 'ai',
    createdAt: new Date().toISOString(),
    durationMinutes: parsed.durationMinutes || durationMinutes,
    model,
    questions,
  }

  if (quizSet.questions.length < minimumQuestionCount) {
    throw new Error('OpenAI returned too many invalid questions. Generate again.')
  }

  return quizSet
}

export async function generateAiEntryDetails({
  apiKey,
  model,
  type,
  term,
  language,
  targetLevel,
}: {
  apiKey: string
  model: string
  type: EntryType
  term: string
  language: LanguageCode
  targetLevel: JlptLevel
}) {
  const instructions = [
    `Generate supporting study-card details for a single JLPT ${targetLevel} entry.`,
    'Do not add furigana formatting, markdown, numbering, or commentary outside the schema.',
    `Return a concise ${outputLanguageLabel(language)} meaning.`,
    'Return one natural Japanese example sentence that clearly uses the term or pattern.',
    `Return a short ${outputLanguageLabel(language)} usage note in notes when helpful; otherwise null.`,
    `Keep the wording, complexity, and nuance appropriate for JLPT ${targetLevel}.`,
    'For vocabulary, return reading in kana when applicable.',
    'For grammar, reading should usually be null unless a kana reading is genuinely useful.',
    'Choose an itemType that fits the term and the selected entry type.',
  ].join('\n')

  const input = JSON.stringify({ type, term, targetLevel })
  const parsed = await requestStructuredOutput<RawEntryDetails>({
    apiKey,
    model,
    instructions,
    input,
    schema: makeEntryDetailsSchema(type),
  })
  const normalized = normalizeAiEntryDetails(type, parsed)

  if (!normalized) {
    throw new Error('OpenAI returned invalid entry details.')
  }

  return normalized
}

export function createDefaultOpenAiSettings(): OpenAiSettings {
  return {
    apiKey: '',
    selectedModel: defaultOpenAiModels[0],
    availableModels: defaultOpenAiModels,
    language: defaultLanguage,
    targetLevel: defaultTargetLevel,
  }
}
