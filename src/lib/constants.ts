import type { LanguageCode } from '../types'

export const defaultOpenAiModels = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']
export const defaultLanguage: LanguageCode = 'en'

export function createEntryId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createQuizSetId() {
  return createEntryId()
}
