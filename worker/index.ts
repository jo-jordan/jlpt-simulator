import { Hono } from 'hono'
import { createEntryId } from '../src/lib/constants'
import { defaultLanguage, defaultOpenAiModels } from '../src/lib/constants'
import { fetchOpenAiModels, generateAiEntryDetails, generateAiQuizSet } from '../src/lib/openai'
import type { EntryType, OpenAiSettings, StudyEntry, StudyLibrary } from '../src/types'
import type { Env } from './env'
import { decryptText, encryptText, hashPassword, signToken, verifyPassword, verifyToken } from './lib/crypto'
import {
  loadUserLibrary,
  prependLibraryEntry,
  replaceLibraryEntryIfPresent,
  replaceUserLibrary,
  seedStarterLibrary,
} from './lib/library-store'

type Variables = {
  userId: string
  email: string
}

type AuthPayload = {
  sub: string
  email: string
  exp: number
}

type UserSettingsRow = {
  openai_key_ciphertext: string | null
  openai_model: string
  language: string
  updated_at: string
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createSessionToken(secret: string, userId: string, email: string) {
  return signToken(secret, {
    sub: userId,
    email,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
  })
}

function buildPendingEntry(type: EntryType, term: string): StudyEntry {
  const requestedAt = new Date().toISOString()

  return {
    id: createEntryId(),
    level: 'N2',
    section: 'language_knowledge',
    subsection: type,
    item_type: type === 'grammar' ? '文の文法1' : '文脈規定',
    source_type: 'original',
    title: null,
    instructions_ja:
      type === 'grammar'
        ? '文法として最も適切なものを選んでください。'
        : '語彙として最も適切なものを選んでください。',
    instructions_zh:
      type === 'grammar' ? '请选择最合适的语法项目。' : '请选择最合适的词汇项目。',
    passage: {
      text: null,
      segments: [],
      metadata: {},
    },
    question: {
      stem: term,
      blank_positions: [],
      choices: [],
      correct_choice_id: null,
      correct_answers: [],
      answer_format: 'single_choice',
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
    difficulty: 'medium',
    estimated_time_sec: type === 'grammar' ? 75 : 45,
    type,
    term,
    meaning: '',
    sourceTitle: 'AI Draft',
    status: 'pending',
    requestedAt,
  }
}

async function enrichEntryInBackground({
  db,
  userId,
  entry,
  apiKey,
  model,
}: {
  db: D1Database
  userId: string
  entry: StudyEntry
  apiKey: string
  model: string
}) {
  try {
    const details = await generateAiEntryDetails({
      apiKey,
      model,
      type: entry.type,
      term: entry.term,
    })
    const completedAt = new Date().toISOString()
    const nextEntry: StudyEntry = {
      ...entry,
      item_type: details.itemType,
      reading: details.reading ?? undefined,
      meaning: details.meaning,
      example: details.example,
      notes: details.notes ?? undefined,
      sourceTitle: 'AI Enriched Entry',
      status: undefined,
      generationError: undefined,
      completedAt,
      passage: {
        text: details.example,
        segments: [details.example],
        metadata: {},
      },
      explanation: {
        ...entry.explanation,
        ja: details.notes ?? null,
      },
    }

    await replaceLibraryEntryIfPresent(db, userId, nextEntry, { updatedAt: completedAt })
  } catch (error) {
    const failedAt = new Date().toISOString()
    const nextEntry: StudyEntry = {
      ...entry,
      status: 'failed',
      generationError: error instanceof Error ? error.message : 'AI entry generation failed.',
      completedAt: failedAt,
    }

    await replaceLibraryEntryIfPresent(db, userId, nextEntry, { updatedAt: failedAt })
  }
}

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/register' || c.req.path === '/api/auth/login') {
    await next()
    return
  }

  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return jsonError('Unauthorized', 401)
  }

  const payload = await verifyToken<AuthPayload>(c.env.APP_SECRET, token)

  if (!payload?.sub || !payload.email) {
    return jsonError('Unauthorized', 401)
  }

  c.set('userId', payload.sub)
  c.set('email', payload.email)
  await next()
})

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
  const email = body.email?.trim().toLowerCase()
  const password = body.password?.trim()

  if (!email || !password || password.length < 8) {
    return jsonError('Email and password (8+ characters) are required.')
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()

  if (existing) {
    return jsonError('This email is already registered.', 409)
  }

  const userId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const passwordHash = await hashPassword(password)

  await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(userId, email, passwordHash, createdAt)
    .run()
  await c.env.DB.prepare(
    'INSERT INTO user_settings (user_id, openai_key_ciphertext, openai_model, language, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(userId, null, defaultOpenAiModels[0], defaultLanguage, createdAt)
    .run()
  await seedStarterLibrary(c.env.DB, userId, createdAt)

  const token = await createSessionToken(c.env.APP_SECRET, userId, email)
  return c.json({ token, user: { id: userId, email } }, 201)
})

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
  const email = body.email?.trim().toLowerCase()
  const password = body.password?.trim()

  if (!email || !password) {
    return jsonError('Email and password are required.')
  }

  const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string }>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return jsonError('Invalid credentials.', 401)
  }

  const token = await createSessionToken(c.env.APP_SECRET, user.id, user.email)
  return c.json({ token, user: { id: user.id, email: user.email } })
})

app.get('/api/auth/me', async (c) => {
  return c.json({ user: { id: c.get('userId'), email: c.get('email') } })
})

app.get('/api/settings', async (c) => {
  const settings = await c.env.DB.prepare(
    'SELECT openai_key_ciphertext, openai_model, language, updated_at FROM user_settings WHERE user_id = ?',
  )
    .bind(c.get('userId'))
    .first<UserSettingsRow>()

  const result: OpenAiSettings & { hasStoredApiKey: boolean } = {
    apiKey: '',
    selectedModel: settings?.openai_model ?? defaultOpenAiModels[0],
    availableModels: defaultOpenAiModels,
    lastSyncedAt: settings?.updated_at,
    language: (settings?.language as OpenAiSettings['language']) ?? defaultLanguage,
    hasStoredApiKey: Boolean(settings?.openai_key_ciphertext),
  }

  return c.json(result)
})

app.put('/api/settings', async (c) => {
  const body = await c.req.json<{
    apiKey?: string
    selectedModel?: string
    language?: OpenAiSettings['language']
  }>()
  const current = await c.env.DB.prepare(
    'SELECT openai_key_ciphertext, openai_model, language FROM user_settings WHERE user_id = ?',
  )
    .bind(c.get('userId'))
    .first<UserSettingsRow>()

  const cipherText =
    body.apiKey === undefined
      ? current?.openai_key_ciphertext ?? null
      : body.apiKey.trim()
        ? await encryptText(c.env.APP_SECRET, body.apiKey.trim())
        : null

  const selectedModel = body.selectedModel?.trim() || current?.openai_model || defaultOpenAiModels[0]
  const language = body.language || (current?.language as OpenAiSettings['language']) || defaultLanguage
  const updatedAt = new Date().toISOString()

  await c.env.DB.prepare(
    'INSERT INTO user_settings (user_id, openai_key_ciphertext, openai_model, language, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET openai_key_ciphertext = excluded.openai_key_ciphertext, openai_model = excluded.openai_model, language = excluded.language, updated_at = excluded.updated_at',
  )
    .bind(c.get('userId'), cipherText, selectedModel, language, updatedAt)
    .run()

  return c.json({
    apiKey: '',
    selectedModel,
    availableModels: defaultOpenAiModels,
    lastSyncedAt: updatedAt,
    language,
    hasStoredApiKey: Boolean(cipherText),
  })
})

app.post('/api/settings/models/refresh', async (c) => {
  const settings = await c.env.DB.prepare(
    'SELECT openai_key_ciphertext, openai_model, language, updated_at FROM user_settings WHERE user_id = ?',
  )
    .bind(c.get('userId'))
    .first<UserSettingsRow>()

  if (!settings?.openai_key_ciphertext) {
    return jsonError('No stored OpenAI API key for this user.', 400)
  }

  const apiKey = await decryptText(c.env.APP_SECRET, settings.openai_key_ciphertext)
  const availableModels = await fetchOpenAiModels(apiKey)

  return c.json({
    apiKey: '',
    selectedModel: availableModels.includes(settings.openai_model)
      ? settings.openai_model
      : availableModels[0],
    availableModels,
    lastSyncedAt: new Date().toISOString(),
    language: (settings.language as OpenAiSettings['language']) ?? defaultLanguage,
    hasStoredApiKey: true,
  })
})

app.get('/api/library', async (c) => {
  return c.json(await loadUserLibrary(c.env.DB, c.get('userId')))
})

app.put('/api/library', async (c) => {
  const library = (await c.req.json()) as StudyLibrary
  return c.json(await replaceUserLibrary(c.env.DB, c.get('userId'), library))
})

app.post('/api/library/entries/ai', async (c) => {
  try {
    const body = await c.req.json<{ type?: EntryType; term?: string }>()
    const type = body.type === 'grammar' ? 'grammar' : 'vocabulary'
    const term = body.term?.trim()

    if (!term) {
      return jsonError('Term is required.', 400)
    }

    const settings = await c.env.DB.prepare(
      'SELECT openai_key_ciphertext, openai_model FROM user_settings WHERE user_id = ?',
    )
      .bind(c.get('userId'))
      .first<UserSettingsRow>()

    if (!settings?.openai_key_ciphertext) {
      return jsonError('No stored OpenAI API key for this user.', 400)
    }

    const apiKey = await decryptText(c.env.APP_SECRET, settings.openai_key_ciphertext)
    const pendingEntry = buildPendingEntry(type, term)
    const library = await prependLibraryEntry(c.env.DB, c.get('userId'), pendingEntry)

    c.executionCtx.waitUntil(
      enrichEntryInBackground({
        db: c.env.DB,
        userId: c.get('userId'),
        entry: pendingEntry,
        apiKey,
        model: settings.openai_model || defaultOpenAiModels[0],
      }),
    )

    return c.json({ entryId: pendingEntry.id, library }, 202)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'AI entry generation failed.',
      502,
    )
  }
})

app.post('/api/quiz/generate', async (c) => {
  try {
    const body = await c.req.json<{ durationMinutes?: number; label?: string }>()
    const settings = await c.env.DB.prepare(
      'SELECT openai_key_ciphertext, openai_model FROM user_settings WHERE user_id = ?',
    )
      .bind(c.get('userId'))
      .first<UserSettingsRow>()

    if (!settings?.openai_key_ciphertext) {
      return jsonError('No stored OpenAI API key for this user.', 400)
    }

    const library = await loadUserLibrary(c.env.DB, c.get('userId'))
    const readyEntries = library.entries.filter((entry) => !entry.status && entry.meaning.trim().length > 0)
    const apiKey = await decryptText(c.env.APP_SECRET, settings.openai_key_ciphertext)
    const quizSet = await generateAiQuizSet({
      apiKey,
      model: settings.openai_model || defaultOpenAiModels[0],
      entries: readyEntries,
      durationMinutes: body.durationMinutes ?? 45,
    })

    if (body.label?.trim()) {
      quizSet.title = body.label.trim()
    }

    const nextLibrary: StudyLibrary = {
      ...library,
      updatedAt: new Date().toISOString(),
      quizSets: [quizSet, ...library.quizSets.filter((item) => item.id !== quizSet.id)],
    }

    return c.json({ quizSet, library: await replaceUserLibrary(c.env.DB, c.get('userId'), nextLibrary) })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'AI quiz generation failed.',
      502,
    )
  }
})

app.all('/api/*', () => jsonError('Not found', 404))

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, executionCtx)
    }

    const assetResponse = await env.ASSETS.fetch(request)

    if (assetResponse.status !== 404) {
      return assetResponse
    }

    return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request))
  },
}
