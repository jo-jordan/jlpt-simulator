import type { LanguageCode, OpenAiSettings, QuizSet, StudyLibrary } from '../types'

export interface ApiSessionUser {
  id: string
  email: string
}

export interface ApiSession {
  token: string
  user: ApiSessionUser
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT'
  token?: string
  body?: unknown
}

async function apiRequest<T>(path: string, options: RequestOptions = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const data = (await response.json()) as T & { error?: { message?: string } }

  if (!response.ok) {
    throw new Error(data.error?.message || 'Request failed.')
  }

  return data
}

export function registerUser(email: string, password: string) {
  return apiRequest<ApiSession>('/api/auth/register', {
    method: 'POST',
    body: { email, password },
  })
}

export function loginUser(email: string, password: string) {
  return apiRequest<ApiSession>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  })
}

export function fetchCurrentUser(token: string) {
  return apiRequest<{ user: ApiSessionUser }>('/api/auth/me', { token })
}

export function fetchRemoteSettings(token: string) {
  return apiRequest<OpenAiSettings & { hasStoredApiKey: boolean }>('/api/settings', { token })
}

export function saveRemoteSettings(
  token: string,
  payload: {
    apiKey?: string
    selectedModel?: string
    language?: OpenAiSettings['language']
  },
) {
  return apiRequest<OpenAiSettings & { hasStoredApiKey: boolean }>('/api/settings', {
    method: 'PUT',
    token,
    body: payload,
  })
}

export function refreshRemoteModels(token: string) {
  return apiRequest<OpenAiSettings & { hasStoredApiKey: boolean }>('/api/settings/models/refresh', {
    method: 'POST',
    token,
  })
}

export function fetchRemoteLibrary(token: string) {
  return apiRequest<StudyLibrary>('/api/library', { token })
}

export function saveRemoteLibrary(token: string, library: StudyLibrary) {
  return apiRequest<StudyLibrary>('/api/library', { method: 'PUT', token, body: library })
}

export function generateRemoteEntry(
  token: string,
  payload: { type: 'vocabulary' | 'grammar'; term: string; language: LanguageCode },
) {
  return apiRequest<{ entryId: string; library: StudyLibrary }>('/api/library/entries/ai', {
    method: 'POST',
    token,
    body: payload,
  })
}

export function generateRemoteQuiz(
  token: string,
  payload: { durationMinutes: number; label: string; language: LanguageCode },
) {
  return apiRequest<{ quizSet: QuizSet; library: StudyLibrary }>('/api/quiz/generate', {
    method: 'POST',
    token,
    body: payload,
  })
}
