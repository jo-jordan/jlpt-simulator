import { createEntryId, createQuizSetId, defaultLanguage, defaultOpenAiModels } from './constants'
import type { EntryType, JlptSection, OpenAiSettings, QuizQuestion, QuizSet, StudyEntry } from '../types'

const OPENAI_API_BASE = 'https://api.openai.com/v1'
const vocabularyItemTypes = ['漢字読み', '表記', '語形成', '文脈規定', '言い換え類義', '用法'] as const
const grammarItemTypes = ['文の文法1', '文の文法2', '文章の文法'] as const
const allowedItemTypes = [...vocabularyItemTypes, ...grammarItemTypes] as const
const targetQuestionCount = 12
const minimumQuestionCount = 8

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

function hasSpecificSingleSelectPrompt(prompt: string) {
  return /[「『][^「」『』]+[」』]/u.test(prompt)
}

function normalizeAiQuestion(question: RawAiQuestion): QuizQuestion | null {
  const prompt = typeof question.prompt === 'string' ? question.prompt.trim() : ''
  const explanation = typeof question.explanation === 'string' ? question.explanation.trim() : ''
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

  if (!prompt || !explanation || !itemType) {
    return null
  }

  const base = {
    id: createEntryId(),
    section,
    prompt,
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

  if (choices.length !== 4 || correctIndex < 0 || correctIndex >= choices.length) {
    return null
  }

  if (expectedKind === 'cloze_select') {
    const sentence = normalizeSentence(question.sentence)

    if (!sentence || !sentence.includes('＿＿＿')) {
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

  if (!sentence && !hasSpecificSingleSelectPrompt(prompt)) {
    return null
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
              'itemType',
              'prompt',
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
              jlptSection: {
                type: 'string',
                enum: ['language_knowledge'],
              },
              itemType: {
                type: 'string',
                enum: [...allowedItemTypes],
              },
              prompt: { type: 'string' },
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
}: {
  apiKey: string
  model: string
  entries: StudyEntry[]
  durationMinutes: number
}): Promise<QuizSet> {
  const trimmedEntries = entries.slice(0, 80).map((entry) => ({
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
    'Generate a realistic JLPT N2 language knowledge quiz set.',
    'Use only the provided source material. Do not invent grammar points or vocabulary outside the input.',
    'Match the real JLPT N2 forms instead of generic quiz styles.',
    'Use these mappings strictly:',
    '- 漢字読み, 表記, 語形成, 言い換え類義, 用法, 文の文法1 => kind=single_select',
    '- 文脈規定, 文の文法2 => kind=cloze_select',
    '- 文章の文法 => kind=order_select',
    'Every question object must include every schema key. Use null for fields that do not apply.',
    'For single_select, the question must be answerable from the output alone. Include a natural Japanese sentence in sentence, or explicitly name the target word or grammar pattern in prompt like 「食べかけ」.',
    'For cloze_select, include exactly one blank shown as ＿＿＿ in sentence.',
    'For single_select and cloze_select, provide exactly 4 choices and a zero-based correctIndex.',
    'Do not use generic prompts like 「文の意味に最も合うものを選んでください」 unless the prompt also names the target expression.',
    'For order_select, fragments and correctOrder must contain the same strings in different order.',
    'For single_select and cloze_select, set fragments=null and correctOrder=null.',
    'For cloze_select, sentence must be a string and choices/correctIndex must be non-null.',
    'For single_select, choices/correctIndex must be non-null. sentence may be null only if prompt names the target expression explicitly.',
    'For order_select, set sentence=null, choices=null, and correctIndex=null.',
    'Keep Japanese natural, concise, and close to real JLPT N2 wording.',
    'Avoid duplicate stems, duplicate answers, and obvious distractors.',
    'Set jlptSection to language_knowledge for every question.',
  ].join('\n')

  const input = JSON.stringify({
    target_duration_minutes: durationMinutes,
    question_count_target: targetQuestionCount,
    minimum_question_count: minimumQuestionCount,
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

  const questions: QuizQuestion[] = parsed.questions
    .map((question) => normalizeAiQuestion(question))
    .filter((question): question is QuizQuestion => Boolean(question))

  const quizSet: QuizSet = {
    id: createQuizSetId(),
    title: parsed.title || 'AI Generated N2 Set',
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
}: {
  apiKey: string
  model: string
  type: EntryType
  term: string
}) {
  const instructions = [
    'Generate supporting study-card details for a single JLPT N2 entry.',
    'Do not add furigana formatting, markdown, numbering, or commentary outside the schema.',
    'Return a concise English meaning.',
    'Return one natural Japanese example sentence that clearly uses the term or pattern.',
    'Return a short English usage note in notes when helpful; otherwise null.',
    'For vocabulary, return reading in kana when applicable.',
    'For grammar, reading should usually be null unless a kana reading is genuinely useful.',
    'Choose an itemType that fits the term and the selected entry type.',
  ].join('\n')

  const input = JSON.stringify({ type, term })
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
  }
}
