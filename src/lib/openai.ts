import { createEntryId, createQuizSetId, defaultLanguage, defaultOpenAiModels } from './constants'
import type { EntryType, OpenAiSettings, QuizQuestion, QuizSet, StudyEntry } from '../types'

const OPENAI_API_BASE = 'https://api.openai.com/v1'

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
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'section', 'prompt', 'explanation', 'sentence', 'choices', 'correctIndex', 'fragments', 'correctOrder'],
            properties: {
              kind: {
                type: 'string',
                enum: ['single_select', 'cloze_select', 'order_select'],
              },
              section: {
                type: 'string',
                enum: ['vocabulary', 'grammar', 'mixed'],
              },
              prompt: { type: 'string' },
              explanation: { type: 'string' },
              sentence: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              choices: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
              correctIndex: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              fragments: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
              correctOrder: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
    },
    strict: true,
  }
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
    .filter((id) => id.startsWith('gpt-'))
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
    type: entry.type,
    term: entry.term,
    reading: entry.reading,
    meaning: entry.meaning,
    example: entry.example,
    notes: entry.notes,
  }))

  const prompt = [
    'Generate a realistic JLPT N2 language knowledge quiz set.',
    'Use only the provided grammar and vocabulary source material.',
    'Mix three question kinds: single_select, cloze_select, and order_select.',
    'Make the style feel like real JLPT drills: concise, high-quality distractors, natural Japanese, and no duplicate questions.',
    '',
    'Field rules — follow exactly:',
    '- kind="cloze_select": sentence is REQUIRED and must contain exactly one blank written as ＿＿＿. Provide exactly 4 choices and a zero-based correctIndex. fragments and correctOrder must be null.',
    '- kind="single_select": sentence is REQUIRED and must be a complete Japanese example sentence that gives context for the question. Provide exactly 4 choices and a zero-based correctIndex. fragments and correctOrder must be null.',
    '- kind="order_select": fragments and correctOrder are REQUIRED arrays of the same strings in shuffled vs. correct order. sentence, choices, and correctIndex must be null.',
    '',
    `Target duration: ${durationMinutes} minutes.`,
    'Create 12 questions if possible, otherwise create at least 8.',
    `Source material: ${JSON.stringify(trimmedEntries)}`,
  ].join('\n')

  const response = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      text: {
        format: {
          type: 'json_schema',
          ...makeQuizSchema(),
        },
      },
      input: prompt,
    }),
  })

  const data = (await response.json()) as OpenAiResponse

  if (!response.ok) {
    throw new Error(data.error?.message || 'OpenAI quiz generation failed.')
  }

  const outputText = extractOutputText(data)

  if (!outputText) {
    throw new Error('OpenAI did not return quiz content.')
  }

  const parsed = JSON.parse(outputText) as {
    title: string
    durationMinutes: number
    questions: Array<Record<string, unknown>>
  }

  const questions: QuizQuestion[] = parsed.questions.map((question) => {
    const section: EntryType | 'mixed' =
      question.section === 'grammar' || question.section === 'vocabulary'
        ? question.section
        : 'mixed'
    const base = {
      id: createEntryId(),
      section,
      prompt: String(question.prompt || ''),
      explanation: String(question.explanation || ''),
    }

    if (question.kind === 'order_select') {
      return {
        ...base,
        kind: 'order_select',
        fragments: Array.isArray(question.fragments)
          ? question.fragments.map((item) => String(item))
          : [],
        correctOrder: Array.isArray(question.correctOrder)
          ? question.correctOrder.map((item) => String(item))
          : [],
      }
    }

    if (question.kind === 'cloze_select') {
      return {
        ...base,
        kind: 'cloze_select',
        sentence: question.sentence ? String(question.sentence) : '',
        choices: Array.isArray(question.choices)
          ? question.choices.map((item) => String(item))
          : [],
        correctIndex: question.correctIndex != null ? Number(question.correctIndex) : 0,
      }
    }

    return {
      ...base,
      kind: 'single_select',
      choices: Array.isArray(question.choices)
        ? question.choices.map((item) => String(item))
        : [],
      correctIndex: question.correctIndex != null ? Number(question.correctIndex) : 0,
    }
  })

  const quizSet: QuizSet = {
    id: createQuizSetId(),
    title: parsed.title || 'AI Generated N2 Set',
    source: 'ai',
    createdAt: new Date().toISOString(),
    durationMinutes: parsed.durationMinutes || durationMinutes,
    model,
    questions,
  }

  quizSet.questions = quizSet.questions.filter((question) => {
    if (question.kind === 'order_select') {
      return question.fragments.length > 1 && question.correctOrder.length === question.fragments.length
    }

    return question.choices.length === 4 && question.correctIndex >= 0 && question.correctIndex < question.choices.length
  })

  if (!quizSet.questions.length) {
    throw new Error('OpenAI returned an invalid quiz set.')
  }

  return quizSet
}

export function createDefaultOpenAiSettings(): OpenAiSettings {
  return {
    apiKey: '',
    selectedModel: defaultOpenAiModels[0],
    availableModels: defaultOpenAiModels,
    language: defaultLanguage,
  }
}
