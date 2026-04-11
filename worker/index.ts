import { Hono } from 'hono'
import { starterLibrary } from '../src/data/starterLibrary'
import { defaultLanguage, defaultOpenAiModels } from '../src/lib/constants'
import { fetchOpenAiModels, generateAiQuizSet } from '../src/lib/openai'
import type { OpenAiSettings, StudyLibrary } from '../src/types'
import type { Env } from './env'
import { decryptText, encryptText, hashPassword, signToken, verifyPassword, verifyToken } from './lib/crypto'

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
  await c.env.DB.prepare('INSERT INTO user_libraries (user_id, library_json, updated_at) VALUES (?, ?, ?)')
    .bind(userId, JSON.stringify(starterLibrary), createdAt)
    .run()

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
  const row = await c.env.DB.prepare('SELECT library_json FROM user_libraries WHERE user_id = ?')
    .bind(c.get('userId'))
    .first<{ library_json: string }>()

  return c.json(row ? (JSON.parse(row.library_json) as StudyLibrary) : starterLibrary)
})

app.put('/api/library', async (c) => {
  const library = (await c.req.json()) as StudyLibrary
  const updatedAt = new Date().toISOString()

  await c.env.DB.prepare(
    'INSERT INTO user_libraries (user_id, library_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET library_json = excluded.library_json, updated_at = excluded.updated_at',
  )
    .bind(c.get('userId'), JSON.stringify({ ...library, updatedAt }), updatedAt)
    .run()

  return c.json({ ...library, updatedAt })
})

app.post('/api/quiz/generate', async (c) => {
  try {
    const body = await c.req.json<{ durationMinutes?: number; label?: string }>()
    const [settings, libraryRow] = await Promise.all([
      c.env.DB.prepare('SELECT openai_key_ciphertext, openai_model FROM user_settings WHERE user_id = ?')
        .bind(c.get('userId'))
        .first<UserSettingsRow>(),
      c.env.DB.prepare('SELECT library_json FROM user_libraries WHERE user_id = ?')
        .bind(c.get('userId'))
        .first<{ library_json: string }>(),
    ])

    if (!settings?.openai_key_ciphertext) {
      return jsonError('No stored OpenAI API key for this user.', 400)
    }

    if (!c.env.APP_SECRET) {
      return jsonError('Server misconfiguration: APP_SECRET is not set.', 500)
    }

    const library = libraryRow ? (JSON.parse(libraryRow.library_json) as StudyLibrary) : starterLibrary
    const apiKey = await decryptText(c.env.APP_SECRET, settings.openai_key_ciphertext)
    const quizSet = await generateAiQuizSet({
      apiKey,
      model: settings.openai_model || defaultOpenAiModels[0],
      entries: library.entries,
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

    await c.env.DB.prepare('UPDATE user_libraries SET library_json = ?, updated_at = ? WHERE user_id = ?')
      .bind(JSON.stringify(nextLibrary), nextLibrary.updatedAt, c.get('userId'))
      .run()

    return c.json({ quizSet, library: nextLibrary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[quiz/generate]', message)
    return jsonError(`Quiz generation failed: ${message}`, 500)
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
