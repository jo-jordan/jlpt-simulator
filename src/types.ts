export type EntryType = 'vocabulary' | 'grammar'
export type StudyEntryStatus = 'pending' | 'failed'
export type LanguageCode = 'en' | 'zh-CN' | 'ja'
export type JlptLevel = 'N1' | 'N2' | 'N3' | 'N4' | 'N5'
export type JlptSection = 'language_knowledge' | 'reading' | 'listening'
export type JlptSubsection = 'vocabulary' | 'grammar' | 'reading' | 'listening'
export type JlptSourceType = 'original' | 'adapted' | 'official_sample' | 'workbook'
export type JlptAnswerFormat =
  | 'single_choice'
  | 'multi_choice'
  | 'ordered_choice'
  | 'free_text'
  | 'audio_single_choice'
export type JlptDifficulty = 'easy' | 'medium' | 'hard'

export interface JlptPassage {
  text: string | null
  segments: string[]
  metadata: Record<string, string | number | boolean | null>
}

export interface JlptChoice {
  id: string
  text: string
}

export interface JlptQuestionPayload {
  stem: string
  blank_positions: number[]
  choices: JlptChoice[]
  correct_choice_id: string | number | null
  correct_answers: Array<string | number>
  answer_format: JlptAnswerFormat
}

export interface JlptAudio {
  audio_id: string | null
  transcript: string | null
  speaker_notes: string[]
  play_limit: number
}

export interface JlptExplanation {
  ja: string | null
  zh: string | null
  grammar_points: string[]
  vocab_points: string[]
}

export interface StudyEntry {
  id: string
  level: JlptLevel
  section: JlptSection
  subsection: JlptSubsection
  item_type: string
  source_type: JlptSourceType
  title: string | null
  instructions_ja: string
  instructions_zh: string | null
  passage: JlptPassage
  question: JlptQuestionPayload
  audio: JlptAudio
  explanation: JlptExplanation
  tags: string[]
  difficulty: JlptDifficulty
  estimated_time_sec: number
  type: EntryType
  term: string
  meaning: string
  reading?: string
  example?: string
  notes?: string
  sourceTitle?: string
  status?: StudyEntryStatus
  generationError?: string
  requestedAt?: string
  completedAt?: string
}

export interface QuizQuestionBase {
  id: string
  sourceEntryId?: string
  targetExpression?: string
  section: EntryType | 'mixed'
  explanation: string
  itemType?: string
  jlptSection?: JlptSection
}

export interface SingleSelectQuestion extends QuizQuestionBase {
  kind: 'single_select'
  sentence?: string
  choices: string[]
  correctIndex: number
}

export interface ClozeSelectQuestion extends QuizQuestionBase {
  kind: 'cloze_select'
  sentence: string
  choices: string[]
  correctIndex: number
}

export interface OrderSelectQuestion extends QuizQuestionBase {
  kind: 'order_select'
  fragments: string[]
  correctOrder: string[]
}

export type QuizQuestion = SingleSelectQuestion | ClozeSelectQuestion | OrderSelectQuestion

export interface QuizSet {
  id: string
  title: string
  source: 'local' | 'ai'
  createdAt: string
  durationMinutes: number
  model?: string
  questions: QuizQuestion[]
}

export interface StudyLibrary {
  title: string
  level: JlptLevel
  updatedAt: string
  entries: StudyEntry[]
  quizSets: QuizSet[]
}

export interface ExamPreset {
  id: string
  label: string
  description: string
  durationMinutes: number
  vocabularyCount: number
  grammarCount: number
}

export type SessionAnswer = number | string[]

export interface ExamSession {
  startedAt: number
  endsAt: number
  quizSet: QuizSet
  answers: Record<string, SessionAnswer>
  submittedAt?: number
  resultRecordId?: string
}

export interface OpenAiSettings {
  apiKey: string
  selectedModel: string
  availableModels: string[]
  lastSyncedAt?: string
  language: LanguageCode
  targetLevel: JlptLevel
}

export interface IncorrectQuestionRecord {
  questionNumber: number
  question: QuizQuestion
  userAnswer?: SessionAnswer
}

export interface QuizResultRecord {
  id: string
  quizSetId: string
  quizTitle: string
  submittedAt: string
  startedAt: string
  durationMs: number
  answeredCount: number
  correctCount: number
  questionCount: number
  scorePercent: number
  incorrectQuestions: IncorrectQuestionRecord[]
}
