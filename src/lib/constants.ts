import type { JlptLevel, LanguageCode } from '../types'

export const defaultOpenAiModels = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']
export const defaultLanguage: LanguageCode = 'en'
export const jlptLevels: JlptLevel[] = ['N1', 'N2', 'N3', 'N4', 'N5']
export const defaultTargetLevel: JlptLevel = 'N2'

export function createEntryId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createQuizSetId() {
  return createEntryId()
}

export function createResultRecordId() {
  return createEntryId()
}
