import { startTransition, useEffect, useRef, useState } from 'react'
import './App.css'
import { starterLibrary } from './data/starterLibrary'
import {
  fetchRemoteResults,
  fetchRemoteLibrary,
  generateRemoteEntry,
  fetchRemoteSettings,
  generateRemoteQuiz,
  regenerateRemoteEntry,
  loginUser,
  refreshRemoteModels,
  saveRemoteResult,
  registerUser,
  saveRemoteLibrary,
  saveRemoteSettings,
  type ApiSession,
} from './lib/api'
import {
  RESULTS_KEY,
  SETTINGS_KEY,
  STORAGE_KEY,
  buildQuizResultRecord,
  countCorrectAnswers,
  countReadyEntries,
  createLibrary,
  examPresets,
  formatRemainingTime,
  getEntryCounts,
  importEntriesFromFile,
  isEntryReady,
  mergeResultRecords,
  normalizeEntry,
  normalizeResultRecords,
  parseLibraryJson,
  sanitizeLibrary,
} from './lib/content'
import { defaultLanguage, jlptLevels } from './lib/constants'
import { t } from './lib/i18n'
import { createDefaultOpenAiSettings } from './lib/openai'
import type {
  EntryType,
  ExamPreset,
  ExamSession,
  LanguageCode,
  OpenAiSettings,
  OrderSelectQuestion,
  QuizQuestion,
  QuizResultRecord,
  QuizSet,
  SessionAnswer,
  StudyEntry,
  StudyLibrary,
} from './types'

const defaultPreset = examPresets[0]
const SESSION_KEY = 'jlpt-simulator-session'
type AppView = 'home' | 'library' | 'records' | 'settings'
type SettingsView = 'root' | 'account' | 'openai'
type EntryEditForm = {
  type: EntryType
  term: string
  reading: string
  meaning: string
  example: string
  notes: string
}

type FileSystemHandle = {
  getFile: () => Promise<File>
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>
    close: () => Promise<void>
  }>
}

type SaveFilePickerWindow = Window & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    excludeAcceptAllOption?: boolean
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FileSystemHandle[]>
}

function formatDate(value: string, language: LanguageCode) {
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function emptyEntryEditForm(): EntryEditForm {
  return {
    type: 'vocabulary',
    term: '',
    reading: '',
    meaning: '',
    example: '',
    notes: '',
  }
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const jsonFileHandleRef = useRef<FileSystemHandle | null>(null)
  const [library, setLibrary] = useState<StudyLibrary>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY)

    if (!saved) {
      return sanitizeLibrary(starterLibrary)
    }

    try {
      return sanitizeLibrary(parseLibraryJson(saved, starterLibrary.title))
    } catch {
      return sanitizeLibrary(starterLibrary)
    }
  })
  const [openAiSettings, setOpenAiSettings] = useState<OpenAiSettings>(() => {
    const saved = window.localStorage.getItem(SETTINGS_KEY)

    if (!saved) {
      return createDefaultOpenAiSettings()
    }

    try {
      return {
        ...createDefaultOpenAiSettings(),
        ...(JSON.parse(saved) as Partial<OpenAiSettings>),
        language:
          (JSON.parse(saved) as Partial<OpenAiSettings>).language ?? createDefaultOpenAiSettings().language,
        targetLevel:
          (JSON.parse(saved) as Partial<OpenAiSettings>).targetLevel ?? createDefaultOpenAiSettings().targetLevel,
      }
    } catch {
      return createDefaultOpenAiSettings()
    }
  })
  const [userSession, setUserSession] = useState<ApiSession | null>(() => {
    const saved = window.localStorage.getItem(SESSION_KEY)

    if (!saved) {
      return null
    }

    try {
      return JSON.parse(saved) as ApiSession
    } catch {
      return null
    }
  })
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPreset.id)
  const [currentView, setCurrentView] = useState<AppView>('home')
  const [settingsView, setSettingsView] = useState<SettingsView>('root')
  const [session, setSession] = useState<ExamSession | null>(null)
  const [resultRecords, setResultRecords] = useState<QuizResultRecord[]>(() => {
    const saved = window.localStorage.getItem(RESULTS_KEY)

    if (!saved) {
      return []
    }

    try {
      return normalizeResultRecords(JSON.parse(saved))
    } catch {
      return []
    }
  })
  const [selectedResultRecordId, setSelectedResultRecordId] = useState<string | null>(null)
  const [remainingMs, setRemainingMs] = useState(defaultPreset.durationMinutes * 60_000)
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0)
  const [importStatus, setImportStatus] = useState(t(defaultLanguage, 'starterLoaded'))
  const [savingStatus, setSavingStatus] = useState('')
  const [aiStatus, setAiStatus] = useState(t(defaultLanguage, 'aiReady'))
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [isCreatingEntry, setIsCreatingEntry] = useState(false)
  const [regeneratingEntryId, setRegeneratingEntryId] = useState<string | null>(null)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [entryForm, setEntryForm] = useState({
    type: 'vocabulary' as EntryType,
    term: '',
  })
  const [editForm, setEditForm] = useState<EntryEditForm>(() => emptyEntryEditForm())

  const selectedPreset =
    examPresets.find((preset) => preset.id === selectedPresetId) ?? defaultPreset
  const language = openAiSettings.language
  const tr = (key: string, params?: Record<string, string | number>) => t(language, key, params)
  const counts = getEntryCounts(library.entries)
  const readyEntryCount = countReadyEntries(library.entries)
  const vocabularyEntries = library.entries.filter((entry) => entry.type === 'vocabulary')
  const grammarEntries = library.entries.filter((entry) => entry.type === 'grammar')
  const currentQuizSet = session?.quizSet
  const questions = currentQuizSet?.questions ?? []
  const activeQuestion = questions[activeQuestionIndex]
  const answeredCount = session ? Object.keys(session.answers).length : 0
  const correctCount = currentQuizSet ? countCorrectAnswers(currentQuizSet, session?.answers ?? {}) : 0
  const scorePercent =
    currentQuizSet && currentQuizSet.questions.length
      ? Math.round((correctCount / currentQuizSet.questions.length) * 100)
      : 0
  const effectiveSubmittedAt =
    session?.submittedAt !== undefined ? Math.min(session.submittedAt, session.endsAt) : undefined
  const elapsedMs =
    session && effectiveSubmittedAt !== undefined ? Math.max(0, effectiveSubmittedAt - session.startedAt) : 0
  const selectedResultRecord =
    resultRecords.find((record) => record.id === selectedResultRecordId) ?? resultRecords[0] ?? null
  const latestResultRecord = resultRecords[0] ?? null
  const totalMistakeCount = resultRecords.reduce((total, record) => total + record.incorrectQuestions.length, 0)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(library))
  }, [library])

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...openAiSettings, apiKey: '' }))
  }, [openAiSettings])

  useEffect(() => {
    window.localStorage.setItem(RESULTS_KEY, JSON.stringify(resultRecords))
  }, [resultRecords])

  useEffect(() => {
    if (userSession) {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(userSession))
      return
    }

    window.localStorage.removeItem(SESSION_KEY)
  }, [userSession])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  useEffect(() => {
    if (!resultRecords.length) {
      if (selectedResultRecordId) {
        setSelectedResultRecordId(null)
      }
      return
    }

    if (!selectedResultRecordId || !resultRecords.some((record) => record.id === selectedResultRecordId)) {
      setSelectedResultRecordId(resultRecords[0].id)
    }
  }, [resultRecords, selectedResultRecordId])

  useEffect(() => {
    if (!userSession) {
      return
    }

    void syncFromCloud(userSession.token, false)
  }, [userSession])

  useEffect(() => {
    if (!userSession) {
      return
    }

    const hasPendingEntries = library.entries.some((entry) => entry.status === 'pending')

    if (!hasPendingEntries) {
      return
    }

    let cancelled = false

    const pollLibrary = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 4000))

        if (cancelled) {
          return
        }

        try {
          const nextLibrary = sanitizeLibrary(await fetchRemoteLibrary(userSession.token))

          if (cancelled) {
            return
          }

          setLibrary(nextLibrary)

          if (!nextLibrary.entries.some((entry) => entry.status === 'pending')) {
            return
          }
        } catch {
          return
        }
      }
    }

    void pollLibrary()

    return () => {
      cancelled = true
    }
  }, [userSession, library.entries.map((entry) => `${entry.id}:${entry.status ?? 'ready'}:${entry.completedAt ?? ''}`).join('|')])

  function presetLabel(preset: ExamPreset) {
    if (preset.id === 'full') return language === 'zh-CN' ? '完整模拟' : language === 'ja' ? 'フル模試' : 'Full Mock'
    if (preset.id === 'focus') return language === 'zh-CN' ? '专注冲刺' : language === 'ja' ? '集中スプリント' : 'Focused Sprint'
    return language === 'zh-CN' ? '快速检测' : language === 'ja' ? 'クイックチェック' : 'Quick Check'
  }

  function presetDescription(preset: ExamPreset) {
    if (preset.id === 'full') {
      return language === 'zh-CN'
        ? '更接近 JLPT 语言知识部分的长时模拟。'
        : language === 'ja'
          ? 'JLPTの言語知識に近い長めの模試です。'
          : 'A longer JLPT-style language knowledge session.'
    }
    if (preset.id === 'focus') {
      return language === 'zh-CN'
        ? '适合日常集中练习的中等题量。'
        : language === 'ja'
          ? '毎日の集中演習に向いた中くらいの分量です。'
          : 'A medium set for daily deliberate practice.'
    }
    return language === 'zh-CN'
      ? '学习前后快速检测的小套题。'
      : language === 'ja'
        ? '学習前後に使える短いチェックです。'
        : 'A short drill before or after study.'
  }

  function questionKindLabel(kind: QuizQuestion['kind']) {
    if (kind === 'single_select') return tr('singleSelect')
    if (kind === 'cloze_select') return tr('clozeSelect')
    return tr('orderSelect')
  }

  function questionFormLabel(question: QuizQuestion) {
    return question.itemType || questionKindLabel(question.kind)
  }

  function formatQuestionAnswer(question: QuizQuestion, answer: SessionAnswer | undefined) {
    if (question.kind === 'order_select') {
      return Array.isArray(answer) && answer.length ? answer.join(' ') : tr('notAnswered')
    }

    return typeof answer === 'number' ? question.choices[answer] : tr('notAnswered')
  }

  function formatCorrectAnswer(question: QuizQuestion) {
    if (question.kind === 'order_select') {
      return question.correctOrder.join(' ')
    }

    return question.choices[question.correctIndex]
  }

  function renderQuestionReview(
    question: QuizQuestion,
    answer: SessionAnswer | undefined,
    questionNumber: number,
    tone: 'good' | 'bad',
  ) {
    return (
      <article key={`${question.id}-${questionNumber}-${tone}`} className={tone === 'good' ? 'result-card good' : 'result-card bad'}>
        <p className="result-index">{tr('questionLabel', { number: questionNumber })}</p>
        {question.itemType ? <p className="muted">{question.itemType}</p> : null}
        <p className="question-prompt small">{question.prompt}</p>
        {question.kind !== 'order_select' && 'sentence' in question && question.sentence ? (
          <p className="muted">{question.sentence}</p>
        ) : null}
        <p>{tr('yourAnswer')}: {formatQuestionAnswer(question, answer)}</p>
        <p>{tr('correctAnswer')}: {formatCorrectAnswer(question)}</p>
        <p className="muted">{question.explanation}</p>
      </article>
    )
  }

  function openSettingsPage(nextPage: SettingsView = 'root') {
    setCurrentView('settings')
    setSettingsView(nextPage)
  }

  useEffect(() => {
    if (!session) {
      setRemainingMs(selectedPreset.durationMinutes * 60_000)
      return
    }

    if (session.submittedAt) {
      setRemainingMs(Math.max(0, session.endsAt - session.submittedAt))
      return
    }

    const updateClock = () => {
      const nextRemaining = session.endsAt - Date.now()
      setRemainingMs(nextRemaining)

      if (nextRemaining <= 0) {
        setSession((current) => {
          if (!current || current.submittedAt) {
            return current
          }

          return {
            ...current,
            submittedAt: Date.now(),
          }
        })
      }
    }

    updateClock()
    const intervalId = window.setInterval(updateClock, 1000)
    return () => window.clearInterval(intervalId)
  }, [selectedPreset.durationMinutes, session])

  useEffect(() => {
    if (!session?.submittedAt || session.resultRecordId) {
      return
    }

    const record = buildQuizResultRecord(session)
    setResultRecords((current) => mergeResultRecords([record], current))
    setSession((current) => {
      if (!current || !current.submittedAt || current.resultRecordId) {
        return current
      }

      return {
        ...current,
        resultRecordId: record.id,
      }
    })

    if (!userSession) {
      return
    }

    void saveRemoteResult(userSession.token, record)
      .then((savedRecord) => {
        setResultRecords((current) => mergeResultRecords([savedRecord], current))
      })
      .catch(() => {
        setSavingStatus('Result saved locally, but cloud sync failed.')
      })
  }, [session, userSession])

  async function writeLibraryToConnectedFile(nextLibrary: StudyLibrary) {
    if (!jsonFileHandleRef.current) {
      return
    }

    const writable = await jsonFileHandleRef.current.createWritable()
    await writable.write(JSON.stringify(nextLibrary, null, 2))
    await writable.close()
  }

  function persistLibrary(nextLibrary: StudyLibrary, statusMessage?: string) {
    const sanitizedLibrary = sanitizeLibrary(nextLibrary)

    startTransition(() => {
      setLibrary(sanitizedLibrary)
    })

    if (statusMessage) {
      setSavingStatus(statusMessage)
    }

    void writeLibraryToConnectedFile(sanitizedLibrary).catch(() => {
      setSavingStatus(tr('saveBackFailed'))
    })

    if (userSession) {
      void saveRemoteLibrary(userSession.token, sanitizedLibrary).catch(() => {
        setSavingStatus('Saved locally, but cloud sync failed.')
      })
    }
  }

  async function syncFromCloud(token: string, announce = true) {
    try {
      const [remoteLibrary, remoteSettings, remoteResults] = await Promise.all([
        fetchRemoteLibrary(token),
        fetchRemoteSettings(token),
        fetchRemoteResults(token),
      ])
      const sanitizedLibrary = sanitizeLibrary(remoteLibrary)

      setLibrary(sanitizedLibrary)
      setResultRecords((current) => mergeResultRecords(normalizeResultRecords(remoteResults), current))
      setOpenAiSettings((current) => ({
        ...current,
        apiKey: '',
        selectedModel: remoteSettings.selectedModel,
        availableModels: remoteSettings.availableModels,
        lastSyncedAt: remoteSettings.lastSyncedAt,
        language: remoteSettings.language,
        targetLevel: remoteSettings.targetLevel,
      }))
      setHasStoredApiKey(remoteSettings.hasStoredApiKey)

      if (sanitizedLibrary.quizSets.length !== remoteLibrary.quizSets.length) {
        void saveRemoteLibrary(token, sanitizedLibrary).catch(() => {
          setAuthStatus('Cloud data synced, but old local quiz sets could not be removed remotely.')
        })
      }

      if (announce) {
        setAuthStatus('Cloud data synced.')
      }
    } catch (error) {
      setAuthStatus(error instanceof Error ? error.message : 'Unable to sync cloud data.')
    }
  }

  function patchEntries(nextEntries: StudyEntry[], title = library.title) {
    persistLibrary(createLibrary(nextEntries, title, library.quizSets, library.level))
  }

  function startSessionFromQuizSet(quizSet: QuizSet) {
    const startedAt = Date.now()

    setSession({
      startedAt,
      endsAt: startedAt + quizSet.durationMinutes * 60_000,
      quizSet,
      answers: {},
    })
    setActiveQuestionIndex(0)
    setRemainingMs(quizSet.durationMinutes * 60_000)
  }

  function submitSession() {
    setSession((current) => {
      if (!current || current.submittedAt) {
        return current
      }

      return {
        ...current,
        submittedAt: Date.now(),
      }
    })
  }

  function answerQuestion(question: QuizQuestion, answer: SessionAnswer) {
    setSession((current) => {
      if (!current || current.submittedAt) {
        return current
      }

      return {
        ...current,
        answers: {
          ...current.answers,
          [question.id]: answer,
        },
      }
    })
  }

  function addOrderFragment(question: OrderSelectQuestion, fragment: string) {
    const existing = session?.answers[question.id]
    const sequence = Array.isArray(existing) ? existing : []

    if (sequence.includes(fragment)) {
      return
    }

    answerQuestion(question, [...sequence, fragment])
  }

  function removeOrderFragment(question: OrderSelectQuestion, index: number) {
    const existing = session?.answers[question.id]
    const sequence = Array.isArray(existing) ? existing : []

    answerQuestion(
      question,
      sequence.filter((_, itemIndex) => itemIndex !== index),
    )
  }

  async function importFiles(fileList: FileList | null) {
    if (!fileList?.length) {
      return
    }

    const importedEntries: StudyEntry[] = []

    for (const file of Array.from(fileList)) {
      try {
        importedEntries.push(...(await importEntriesFromFile(file)))
      } catch {
        setImportStatus(tr('importFailed', { fileName: file.name }))
        return
      }
    }

    if (!importedEntries.length) {
      setImportStatus(tr('noValidEntries'))
      return
    }

    patchEntries([...library.entries, ...importedEntries], library.title)
    setImportStatus(tr('importedEntries', { count: importedEntries.length, files: fileList.length }))
  }

  async function openJsonFile() {
    const pickerWindow = window as SaveFilePickerWindow

    if (!pickerWindow.showOpenFilePicker) {
      setSavingStatus(tr('directEditNotSupported'))
      return
    }

    const [handle] = await pickerWindow.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: true,
      types: [
        {
          description: 'JSON library',
          accept: {
            'application/json': ['.json'],
          },
        },
      ],
    })

    if (!handle) {
      return
    }

    const file = await handle.getFile()
    const nextLibrary = parseLibraryJson(await file.text(), file.name.replace(/\.json$/i, ''))
    jsonFileHandleRef.current = handle
    persistLibrary(nextLibrary, tr('connectedWritableJson'))
    setImportStatus(tr('openedJson', { fileName: file.name }))
  }

  async function saveBackToJson() {
    if (!jsonFileHandleRef.current) {
      setSavingStatus(tr('noConnectedJson'))
      return
    }

    await writeLibraryToConnectedFile(library)
    setSavingStatus(tr('savedBackToJson'))
  }

  function exportLibrary() {
    const blob = new Blob([JSON.stringify(library, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${library.title.toLowerCase().replace(/\s+/g, '-') || 'jlpt-n2-library'}.json`
    link.click()
    URL.revokeObjectURL(url)
    setSavingStatus(tr('exportedJson'))
  }

  async function addEntryWithAi() {
    const term = entryForm.term.trim()

    if (!term) {
      setSavingStatus(tr('termRequired'))
      return
    }

    if (!userSession) {
      openSettingsPage('account')
      setSavingStatus(tr('signInBeforeAiEntry'))
      return
    }

    if (!hasStoredApiKey) {
      openSettingsPage('openai')
      setSavingStatus(tr('addApiKeyBeforeAiEntry'))
      return
    }

    setIsCreatingEntry(true)

    try {
      const { library: nextLibrary } = await generateRemoteEntry(userSession.token, {
        type: entryForm.type,
        term,
        language: openAiSettings.language,
        targetLevel: openAiSettings.targetLevel,
      })

      setLibrary(nextLibrary)
      setEntryForm({
        type: 'vocabulary',
        term: '',
      })
      setSavingStatus(tr('entryAiQueued', { term }))
    } catch (error) {
      setSavingStatus(error instanceof Error ? error.message : tr('entryAiFailed'))
    } finally {
      setIsCreatingEntry(false)
    }
  }

  function startEditEntry(entry: StudyEntry) {
    setEditingEntryId(entry.id)
    setEditForm({
      type: entry.type,
      term: entry.term,
      reading: entry.reading ?? '',
      meaning: entry.meaning,
      example: entry.example ?? '',
      notes: entry.notes ?? '',
    })
  }

  function cancelEditEntry() {
    setEditingEntryId(null)
    setEditForm(emptyEntryEditForm())
  }

  function saveEditedEntry(entryId: string) {
    const existingEntry = library.entries.find((entry) => entry.id === entryId)
    const term = editForm.term.trim()
    const meaning = editForm.meaning.trim()
    const reading = editForm.reading.trim()
    const example = editForm.example.trim()
    const notes = editForm.notes.trim()

    if (!existingEntry || !term || !meaning) {
      setSavingStatus(tr('termMeaningRequired'))
      return
    }

    const nextEntry = normalizeEntry(
      {
        ...existingEntry,
        type: editForm.type,
        subsection: editForm.type,
        term,
        reading: reading || undefined,
        meaning,
        example: example || undefined,
        notes: notes || undefined,
        item_type: existingEntry.type === editForm.type ? existingEntry.item_type : undefined,
        status: undefined,
        generationError: undefined,
        completedAt: new Date().toISOString(),
        passage: {
          ...existingEntry.passage,
          text: example || null,
          segments: example ? [example] : [],
        },
        question: {
          ...existingEntry.question,
          stem: term,
        },
        explanation: {
          ja: language === 'ja' ? (notes || null) : existingEntry.explanation.ja,
          zh: language === 'zh-CN' ? (notes || null) : existingEntry.explanation.zh,
          grammar_points:
            editForm.type === 'grammar'
              ? existingEntry.type === editForm.type
                ? existingEntry.explanation.grammar_points
                : [term]
              : [],
          vocab_points:
            editForm.type === 'vocabulary'
              ? existingEntry.type === editForm.type
                ? existingEntry.explanation.vocab_points
                : [term]
              : [],
        },
      },
      existingEntry.sourceTitle,
    )

    if (!nextEntry) {
      setSavingStatus(tr('termMeaningRequired'))
      return
    }

    patchEntries(
      library.entries.map((entry) => (entry.id === entryId ? nextEntry : entry)),
      library.title,
    )
    cancelEditEntry()
    setSavingStatus(tr('entryUpdated', { term }))
  }

  async function regenerateEntry(entry: StudyEntry) {
    const term = entry.term.trim()

    if (!term || entry.status === 'pending') {
      return
    }

    if (!userSession) {
      openSettingsPage('account')
      setSavingStatus(tr('signInBeforeAiEntry'))
      return
    }

    if (!hasStoredApiKey) {
      openSettingsPage('openai')
      setSavingStatus(tr('addApiKeyBeforeAiEntry'))
      return
    }

    setRegeneratingEntryId(entry.id)

    if (editingEntryId === entry.id) {
      cancelEditEntry()
    }

    try {
      const { library: nextLibrary } = await regenerateRemoteEntry(userSession.token, entry.id, {
        type: entry.type,
        term,
        language: openAiSettings.language,
        targetLevel: openAiSettings.targetLevel,
      })

      setLibrary(nextLibrary)
      setSavingStatus(tr('entryAiRegenerating', { term }))
    } catch (error) {
      setSavingStatus(error instanceof Error ? error.message : tr('entryAiFailed'))
    } finally {
      setRegeneratingEntryId((current) => (current === entry.id ? null : current))
    }
  }

  function removeEntry(entryId: string) {
    if (editingEntryId === entryId) {
      cancelEditEntry()
    }

    patchEntries(library.entries.filter((entry) => entry.id !== entryId))
  }

  function renderLibraryEntries(entries: StudyEntry[]) {
    if (!entries.length) {
      return (
        <div className="empty-state compact">
          <p>{tr('noEntriesYet')}</p>
        </div>
      )
    }

    return (
      <div className="entry-table scrollable large-scroll">
        {entries.map((entry) => (
          <div key={entry.id} className="entry-row">
            <div className="entry-content">
              <div className="entry-primary">
                <strong>{entry.term}</strong>
                <p>
                  {entry.type} · {entry.item_type} · {entry.status === 'pending'
                    ? tr('entryAiPending')
                    : entry.status === 'failed'
                      ? tr('entryAiFailed')
                      : entry.meaning}
                </p>
                {entry.reading ? <p className="muted">{entry.reading}</p> : null}
                {entry.status === 'failed' && entry.generationError ? (
                  <p className="muted">{entry.generationError}</p>
                ) : null}
                {isEntryReady(entry) && entry.example ? (
                  <p className="muted">{entry.example}</p>
                ) : null}
              </div>

              <div className="entry-actions">
                <button
                  className="ghost-button compact"
                  disabled={entry.status === 'pending'}
                  onClick={() =>
                    editingEntryId === entry.id ? cancelEditEntry() : startEditEntry(entry)
                  }
                >
                  {editingEntryId === entry.id ? tr('cancel') : tr('edit')}
                </button>
                <button
                  className="ghost-button compact"
                  disabled={entry.status === 'pending' || regeneratingEntryId === entry.id}
                  onClick={() => void regenerateEntry(entry)}
                >
                  {regeneratingEntryId === entry.id ? tr('regeneratingEntry') : tr('regenerate')}
                </button>
                <button className="ghost-button compact" onClick={() => removeEntry(entry.id)}>{tr('remove')}</button>
              </div>
            </div>

            {editingEntryId === entry.id ? (
              <div className="entry-edit-form">
                <div className="entry-edit-grid">
                  <label>
                    {tr('type')}
                    <select
                      value={editForm.type}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          type: event.target.value as EntryType,
                        }))
                      }
                    >
                      <option value="vocabulary">{tr('vocabulary')}</option>
                      <option value="grammar">{tr('grammar')}</option>
                    </select>
                  </label>
                  <label>
                    {tr('termOrPattern')}
                    <input
                      value={editForm.term}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, term: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    {tr('reading')}
                    <input
                      value={editForm.reading}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, reading: event.target.value }))
                      }
                      placeholder={tr('optional')}
                    />
                  </label>
                  <label>
                    {tr('meaning')}
                    <input
                      value={editForm.meaning}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, meaning: event.target.value }))
                      }
                    />
                  </label>
                  <label className="wide">
                    {tr('exampleSentence')}
                    <textarea
                      value={editForm.example}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, example: event.target.value }))
                      }
                    />
                  </label>
                  <label className="wide">
                    {tr('notes')}
                    <textarea
                      value={editForm.notes}
                      onChange={(event) =>
                        setEditForm((current) => ({ ...current, notes: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <div className="button-row">
                  <button className="primary-button" onClick={() => saveEditedEntry(entry.id)}>{tr('save')}</button>
                  <button className="ghost-button" onClick={cancelEditEntry}>{tr('cancel')}</button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    )
  }

  function resetToStarter() {
    jsonFileHandleRef.current = null
    persistLibrary(starterLibrary, tr('starterReset'))
    setImportStatus(tr('starterRestored'))
  }

  async function refreshModels() {
    if (!userSession) {
      setAiStatus('Sign in first to refresh models from the backend.')
      return
    }

    setIsRefreshingModels(true)

    try {
      const remoteSettings = await refreshRemoteModels(userSession.token)
      setOpenAiSettings((current) => ({
        ...current,
        apiKey: '',
        availableModels: remoteSettings.availableModels,
        selectedModel: remoteSettings.selectedModel,
        lastSyncedAt: remoteSettings.lastSyncedAt,
        language: remoteSettings.language,
        targetLevel: remoteSettings.targetLevel,
      }))
      setHasStoredApiKey(remoteSettings.hasStoredApiKey)
      setAiStatus(tr('fetchedModels'))
    } catch (error) {
      setAiStatus(error instanceof Error ? error.message : tr('unableRefreshModels'))
    } finally {
      setIsRefreshingModels(false)
    }
  }

  async function generateQuizWithAi() {
    if (!userSession) {
      openSettingsPage('account')
      setAiStatus('Sign in first to use server-side AI generation.')
      return
    }

    if (readyEntryCount < 6) {
      setAiStatus(tr('addMoreEntriesForAi'))
      return
    }

    setIsGenerating(true)
    setAiStatus(
      tr('generatingWithModel', {
        preset: presetLabel(selectedPreset).toLowerCase(),
        model: openAiSettings.selectedModel,
      }),
    )

    try {
      const { quizSet, library: nextLibrary } = await generateRemoteQuiz(userSession.token, {
        durationMinutes: selectedPreset.durationMinutes,
        label: `${presetLabel(selectedPreset)} · ${tr('aiGeneratedSet')}`,
        language: openAiSettings.language,
        targetLevel: openAiSettings.targetLevel,
      })
      setLibrary(nextLibrary)
      setAiStatus(tr('generatedQuizNamed', { title: quizSet.title }))
    } catch (error) {
      setAiStatus(error instanceof Error ? error.message : tr('aiQuizFailed'))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleRegister() {
    setIsAuthLoading(true)

    try {
      const sessionResult = await registerUser(authEmail, authPassword)
      setUserSession(sessionResult)
      setHasStoredApiKey(false)
      setAuthStatus(`Registered ${sessionResult.user.email}.`)
      setAuthPassword('')
    } catch (error) {
      setAuthStatus(error instanceof Error ? error.message : 'Registration failed.')
    } finally {
      setIsAuthLoading(false)
    }
  }

  async function handleLogin() {
    setIsAuthLoading(true)

    try {
      const sessionResult = await loginUser(authEmail, authPassword)
      setUserSession(sessionResult)
      setAuthStatus(`Signed in as ${sessionResult.user.email}.`)
      setAuthPassword('')
    } catch (error) {
      setAuthStatus(error instanceof Error ? error.message : 'Sign in failed.')
    } finally {
      setIsAuthLoading(false)
    }
  }

  async function handleSaveCloudSettings() {
    if (!userSession) {
      setAuthStatus('Sign in first to save settings in Cloudflare.')
      return
    }

    try {
      const remoteSettings = await saveRemoteSettings(userSession.token, {
        apiKey: openAiSettings.apiKey.trim() || undefined,
        selectedModel: openAiSettings.selectedModel,
        language: openAiSettings.language,
        targetLevel: openAiSettings.targetLevel,
      })
      setOpenAiSettings((current) => ({
        ...current,
        apiKey: '',
        selectedModel: remoteSettings.selectedModel,
        availableModels: remoteSettings.availableModels,
        lastSyncedAt: remoteSettings.lastSyncedAt,
        language: remoteSettings.language,
        targetLevel: remoteSettings.targetLevel,
      }))
      setHasStoredApiKey(remoteSettings.hasStoredApiKey)
      setAuthStatus('Cloud settings saved.')
    } catch (error) {
      setAuthStatus(error instanceof Error ? error.message : 'Unable to save cloud settings.')
    }
  }

  function handleSignOut() {
    setUserSession(null)
    setHasStoredApiKey(false)
    setAuthStatus('Signed out. Local mode is active.')
  }

  if (session && currentQuizSet) {
    const submitted = Boolean(session.submittedAt)

    return (
      <main className="session-shell">
        <header className="session-header">
          <div>
            <p className="eyebrow">{tr('examMode')}</p>
            <h1 className="session-title">{currentQuizSet.title}</h1>
            <p className="session-subtitle">
              {tr('aiGeneratedSet')} · {tr('questionsCount', { count: questions.length })}
            </p>
          </div>
          <div className="session-actions">
            <div className={`timer-chip large ${remainingMs <= 300_000 ? 'danger' : ''}`}>
              {formatRemainingTime(remainingMs)}
            </div>
            <button
              className="ghost-button"
              onClick={submitSession}
            >
              {tr('submitExam')}
            </button>
            <button className="ghost-button" onClick={() => setSession(null)}>{tr('exit')}</button>
          </div>
        </header>

        {!submitted && activeQuestion ? (
          <section className="session-main">
            <aside className="question-index">
              {questions.map((question, index) => {
                const answered = question.id in (session.answers ?? {})
                const active = index === activeQuestionIndex

                return (
                  <button
                    key={question.id}
                    className={`index-pill${active ? ' active' : ''}${answered ? ' answered' : ''}`}
                    onClick={() => setActiveQuestionIndex(index)}
                  >
                    {index + 1}
                  </button>
                )
              })}
            </aside>

            <article className="exam-stage">
              <div className="exam-meta">
                <span>
                  {tr('questionProgress', { current: activeQuestionIndex + 1, total: questions.length })}
                </span>
                <span>{questionFormLabel(activeQuestion)}</span>
              </div>

              <p className="exam-prompt">{activeQuestion.prompt}</p>

              {activeQuestion.kind === 'single_select' && activeQuestion.sentence ? (
                <div className="sentence-card">{activeQuestion.sentence}</div>
              ) : null}

              {activeQuestion.kind === 'single_select' ? (
                <div className="choice-list large">
                  {activeQuestion.choices.map((choice, choiceIndex) => (
                    <button
                      key={`${activeQuestion.id}-${choice}`}
                      className={
                        session.answers[activeQuestion.id] === choiceIndex ? 'choice selected' : 'choice'
                      }
                      onClick={() => answerQuestion(activeQuestion, choiceIndex)}
                    >
                      <span>{String.fromCharCode(65 + choiceIndex)}</span>
                      <p>{choice}</p>
                    </button>
                  ))}
                </div>
              ) : null}

              {activeQuestion.kind === 'cloze_select' ? (
                <>
                  <div className="sentence-card">{activeQuestion.sentence}</div>
                  <div className="choice-list large">
                    {activeQuestion.choices.map((choice, choiceIndex) => (
                      <button
                        key={`${activeQuestion.id}-${choice}`}
                        className={
                          session.answers[activeQuestion.id] === choiceIndex ? 'choice selected' : 'choice'
                        }
                        onClick={() => answerQuestion(activeQuestion, choiceIndex)}
                      >
                        <span>{String.fromCharCode(65 + choiceIndex)}</span>
                        <p>{choice}</p>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              {activeQuestion.kind === 'order_select' ? (
                <OrderQuestionView
                  language={language}
                  question={activeQuestion}
                  answer={session.answers[activeQuestion.id]}
                  onAdd={addOrderFragment}
                  onRemove={removeOrderFragment}
                />
              ) : null}

              <div className="session-nav">
                <button
                  className="ghost-button"
                  disabled={activeQuestionIndex === 0}
                  onClick={() => setActiveQuestionIndex((index) => Math.max(0, index - 1))}
                >
                  {tr('previous')}
                </button>
                <button
                  className="ghost-button"
                  disabled={activeQuestionIndex === questions.length - 1}
                  onClick={() =>
                    setActiveQuestionIndex((index) => Math.min(questions.length - 1, index + 1))
                  }
                >
                  {tr('next')}
                </button>
              </div>
            </article>
          </section>
        ) : (
          <section className="results-shell">
            <div className="results-hero">
              <p className="eyebrow">{tr('results')}</p>
              <h2>
                {correctCount} / {questions.length} correct
              </h2>
              <p className="session-subtitle">{tr('overallScore', { score: scorePercent })}</p>
              <div className="button-row centered-row">
                <button
                  className="ghost-button compact"
                  onClick={() => {
                    setCurrentView('records')
                    setSession(null)
                  }}
                >
                  {tr('records')}
                </button>
              </div>
            </div>

            <div className="score-strip large">
              <div>
                <strong>{answeredCount}</strong>
                <span>{tr('answered')}</span>
              </div>
              <div>
                <strong>{correctCount}</strong>
                <span>{tr('correct')}</span>
              </div>
              <div>
                <strong>{scorePercent}%</strong>
                <span>{tr('score')}</span>
              </div>
              <div>
                <strong>{formatRemainingTime(elapsedMs)}</strong>
                <span>{tr('timeSpent')}</span>
              </div>
            </div>

            <div className="results-list full">
              {questions.map((question, index) => {
                const answer = session.answers[question.id]
                const isCorrect =
                  question.kind === 'order_select'
                    ? Array.isArray(answer) && answer.join('||') === question.correctOrder.join('||')
                    : typeof answer === 'number' && answer === question.correctIndex

                return renderQuestionReview(question, answer, index + 1, isCorrect ? 'good' : 'bad')
              })}
            </div>

            <div className="session-nav">
              <button className="primary-button" onClick={() => setSession(null)}>
                {tr('returnHome')}
              </button>
            </div>
          </section>
        )}
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">JLPT {openAiSettings.targetLevel} Simulator</p>
          <h1 className="page-title">
            {currentView === 'library'
              ? tr('libraryPageTitle')
              : currentView === 'records'
                ? tr('recordsPageTitle')
              : currentView === 'settings'
                ? tr('settingsPageTitle')
                : tr('homeTitle')}
          </h1>
        </div>
        <div className="topbar-actions">
          <nav className="view-switch" aria-label="Primary">
            <button
              className={currentView === 'home' ? 'ghost-button active-tab' : 'ghost-button'}
              onClick={() => setCurrentView('home')}
            >
              {tr('homeNav')}
            </button>
            <button
              className={currentView === 'library' ? 'ghost-button active-tab' : 'ghost-button'}
              onClick={() => setCurrentView('library')}
            >
              {tr('library')}
            </button>
            <button
              className={currentView === 'records' ? 'ghost-button active-tab' : 'ghost-button'}
              onClick={() => setCurrentView('records')}
            >
              {tr('records')}
            </button>
            <button
              className={currentView === 'settings' ? 'ghost-button active-tab' : 'ghost-button'}
              onClick={() => openSettingsPage(settingsView)}
            >
              {tr('settings')}
            </button>
          </nav>
          <button
            className="primary-button"
            disabled={isGenerating}
            onClick={() => {
              setCurrentView('home')
              void generateQuizWithAi()
            }}
          >
            {isGenerating ? tr('generating') : tr('generateAiQuiz')}
          </button>
        </div>
      </header>

      {currentView === 'home' ? (
        <>
          <section className="hero-panel compact">
            <div className="hero-copy">
              <div>
                <p className="hero-kicker">{tr('heroKicker')}</p>
                <p className="lede">{tr('heroDescription')}</p>
              </div>
              <div className="hero-stats">
                <div className="stat-card accent">
                  <span>{counts.vocabulary}</span>
                  <p>{tr('vocabulary')}</p>
                </div>
                <div className="stat-card">
                  <span>{counts.grammar}</span>
                  <p>{tr('grammar')}</p>
                </div>
                <div className="stat-card">
                  <span>{library.quizSets.length}</span>
                  <p>{tr('savedQuizSets')}</p>
                </div>
              </div>
            </div>
          </section>

          <section className="grid main-grid">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('aiStudio')}</p>
                  <h2>{tr('generateRealisticSets')}</h2>
                </div>
              </div>

              <div className="preset-row">
                {examPresets.map((preset) => (
                  <button
                    key={preset.id}
                    className={preset.id === selectedPresetId ? 'preset active' : 'preset'}
                    onClick={() => setSelectedPresetId(preset.id)}
                  >
                    <strong>{presetLabel(preset)}</strong>
                    <span>
                      {tr('minutesItems', {
                        minutes: preset.durationMinutes,
                        items: preset.vocabularyCount + preset.grammarCount,
                      })}
                    </span>
                  </button>
                ))}
              </div>

              <div className="session-cta">
                <div>
                  <strong>{presetLabel(selectedPreset)}</strong>
                  <p>{presetDescription(selectedPreset)}</p>
                </div>
                <button className="primary-button" disabled={isGenerating} onClick={() => void generateQuizWithAi()}>
                  {isGenerating ? tr('generating') : tr('generateAiQuiz')}
                </button>
              </div>
            </article>

            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('model')}</p>
                  <h2>{tr('openAiSettings')}</h2>
                </div>
              </div>

              <div className="ai-overview">
                <p>
                  {tr('model')}: <strong>{openAiSettings.selectedModel}</strong>
                </p>
                <p>
                  {tr('learningTarget')}: <strong>{openAiSettings.targetLevel}</strong>
                </p>
                <p>
                  {tr('apiKey')}: <strong>{hasStoredApiKey ? tr('configured') : tr('missing')}</strong>
                </p>
              </div>

              <p className="status-line">{aiStatus}</p>
              <div className="button-row">
                <button className="primary-button" disabled={isGenerating} onClick={() => void generateQuizWithAi()}>
                  {isGenerating ? tr('generating') : tr('generateAiQuiz')}
                </button>
                <button className="ghost-button" onClick={() => openSettingsPage('openai')}>{tr('openAiSettings')}</button>
              </div>
            </article>
          </section>

          <section className="grid">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('savedSets')}</p>
                  <h2>{tr('reusableGeneratedPapers')}</h2>
                </div>
              </div>

              {library.quizSets.length ? (
                <div className="saved-list">
                  {library.quizSets.map((quizSet) => (
                    <article key={quizSet.id} className="saved-card">
                      <div>
                        <strong>{quizSet.title}</strong>
                        <p>
                          {tr('aiGeneratedSet')} · {tr('questionsCount', { count: quizSet.questions.length })} ·{' '}
                          {tr('minutesItems', { minutes: quizSet.durationMinutes, items: quizSet.questions.length })}
                        </p>
                        <p className="muted">{formatDate(quizSet.createdAt, language)}</p>
                      </div>
                      <button className="ghost-button compact" onClick={() => startSessionFromQuizSet(quizSet)}>{tr('start')}</button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state compact">
                  <p>{tr('noSavedQuizSets')}</p>
                </div>
              )}
            </article>

            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('librarySnapshot')}</p>
                  <h2>{tr('currentStudyBase')}</h2>
                </div>
                <button className="ghost-button compact" onClick={() => setCurrentView('library')}>{tr('openLibrary')}</button>
              </div>

              <div className="snapshot-grid">
                {library.entries.slice(0, 6).map((entry) => (
                  <div key={entry.id} className="snapshot-card">
                    <strong>{entry.term}</strong>
                    <p>
                      {entry.type} · {entry.item_type} · {entry.status === 'pending'
                        ? tr('entryAiPending')
                        : entry.status === 'failed'
                          ? tr('entryAiFailed')
                          : entry.meaning}
                    </p>
                  </div>
                ))}
              </div>
              <p className="status-line muted">{importStatus}</p>
              {savingStatus ? <p className="status-line muted">{savingStatus}</p> : null}
            </article>
          </section>
        </>
      ) : null}

      {currentView === 'library' ? (
        <>
          <section className="hero-panel compact library-hero">
            <div className="hero-copy">
              <div>
                <p className="hero-kicker">{tr('library')}</p>
                <p className="lede">{tr('libraryHeroDescription')}</p>
              </div>
              <div className="hero-stats">
                <div className="stat-card accent">
                  <span>{library.entries.length}</span>
                  <p>{tr('entries')}</p>
                </div>
                <div className="stat-card">
                  <span>{counts.vocabulary}</span>
                  <p>{tr('vocabulary')}</p>
                </div>
                <div className="stat-card">
                  <span>{counts.grammar}</span>
                  <p>{tr('grammar')}</p>
                </div>
              </div>
            </div>
          </section>

          <section className="grid main-grid">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('importSaveExport')}</p>
                  <h2>{tr('libraryOperationsTitle')}</h2>
                </div>
              </div>

              <div className="button-row">
                <button className="primary-button" onClick={() => fileInputRef.current?.click()}>{tr('importDocs')}</button>
                <button className="ghost-button" onClick={() => void openJsonFile()}>{tr('openJsonForEditing')}</button>
                <button className="ghost-button" onClick={() => void saveBackToJson()}>{tr('saveBackToJsonButton')}</button>
                <button className="ghost-button" onClick={exportLibrary}>{tr('exportJson')}</button>
                <button className="ghost-button" onClick={resetToStarter}>{tr('resetStarterDeck')}</button>
              </div>

              <input
                ref={fileInputRef}
                className="hidden-input"
                type="file"
                accept=".json,.md,.txt,.docx"
                multiple
                onChange={(event) => {
                  void importFiles(event.target.files)
                  event.currentTarget.value = ''
                }}
              />

              <p className="status-line">{importStatus}</p>
              {savingStatus ? <p className="status-line muted">{savingStatus}</p> : null}
            </article>

            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('newEntry')}</p>
                  <h2>{tr('addContentWithAi')}</h2>
                  <p className="muted">{tr('entryAiDescription')}</p>
                </div>
              </div>

              <div className="form-grid">
                <label>
                  {tr('type')}
                  <select
                    value={entryForm.type}
                    onChange={(event) =>
                      setEntryForm((current) => ({
                        ...current,
                        type: event.target.value as EntryType,
                      }))
                    }
                  >
                    <option value="vocabulary">{tr('vocabulary')}</option>
                    <option value="grammar">{tr('grammar')}</option>
                  </select>
                </label>
                <label>
                  {tr('termOrPattern')}
                  <input
                    value={entryForm.term}
                    onChange={(event) =>
                      setEntryForm((current) => ({ ...current, term: event.target.value }))
                    }
                    placeholder="例: 〜わけではない"
                  />
                </label>
              </div>

              <div className="button-row">
                <button className="primary-button" disabled={isCreatingEntry} onClick={() => void addEntryWithAi()}>
                  {isCreatingEntry ? tr('queueingAiEntry') : tr('addEntryWithAi')}
                </button>
              </div>
            </article>
          </section>

          <section className="grid library-split-grid">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('entries')}</p>
                  <h2>{tr('vocabulary')}</h2>
                  <p className="muted">{tr('entriesCount', { count: vocabularyEntries.length })}</p>
                </div>
              </div>

              {renderLibraryEntries(vocabularyEntries)}
            </article>

            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('entries')}</p>
                  <h2>{tr('grammar')}</h2>
                  <p className="muted">{tr('entriesCount', { count: grammarEntries.length })}</p>
                </div>
              </div>

              {renderLibraryEntries(grammarEntries)}
            </article>
          </section>
        </>
      ) : null}

      {currentView === 'records' ? (
        <>
          <section className="hero-panel compact">
            <div className="hero-copy">
              <div>
                <p className="hero-kicker">{tr('records')}</p>
                <p className="lede">{tr('recordsHeroDescription')}</p>
              </div>
              <div className="hero-stats">
                <div className="stat-card accent">
                  <span>{resultRecords.length}</span>
                  <p>{tr('attempts')}</p>
                </div>
                <div className="stat-card">
                  <span>{totalMistakeCount}</span>
                  <p>{tr('wrongAnswers')}</p>
                </div>
                <div className="stat-card">
                  <span>{latestResultRecord ? `${latestResultRecord.scorePercent}%` : '—'}</span>
                  <p>{tr('latestScore')}</p>
                </div>
              </div>
            </div>
          </section>

          <section className="grid records-grid">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('records')}</p>
                  <h2>{tr('latestAttempts')}</h2>
                </div>
              </div>

              {resultRecords.length ? (
                <div className="records-list">
                  {resultRecords.map((record) => (
                    <button
                      key={record.id}
                      className={record.id === selectedResultRecord?.id ? 'record-card active' : 'record-card'}
                      onClick={() => setSelectedResultRecordId(record.id)}
                    >
                      <div className="record-card-head">
                        <strong>{record.quizTitle}</strong>
                        <span>{record.scorePercent}%</span>
                      </div>
                      <p className="muted">{formatDate(record.submittedAt, language)}</p>
                      <p className="muted">
                        {tr('questionsCount', { count: record.questionCount })} · {tr('wrongAnswersCount', { count: record.incorrectQuestions.length })} ·{' '}
                        {tr('timeSpent')}: {formatRemainingTime(record.durationMs)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state compact">
                  <p>{tr('noResultRecords')}</p>
                </div>
              )}
            </article>

            <article className="panel">
              <div className="panel-head">
                <div>
                  <p className="section-label">{tr('reviewMistakes')}</p>
                  <h2>{selectedResultRecord ? selectedResultRecord.quizTitle : tr('reviewMistakes')}</h2>
                  {selectedResultRecord ? (
                    <p className="muted">
                      {formatDate(selectedResultRecord.submittedAt, language)} · {selectedResultRecord.scorePercent}% · {tr('timeSpent')}:{' '}
                      {formatRemainingTime(selectedResultRecord.durationMs)}
                    </p>
                  ) : null}
                </div>
              </div>

              {!selectedResultRecord ? (
                <div className="empty-state compact">
                  <p>{tr('noResultRecords')}</p>
                </div>
              ) : selectedResultRecord.incorrectQuestions.length ? (
                <div className="results-list full">
                  {selectedResultRecord.incorrectQuestions.map((item) =>
                    renderQuestionReview(item.question, item.userAnswer, item.questionNumber, 'bad'),
                  )}
                </div>
              ) : (
                <div className="empty-state compact">
                  <p>{tr('perfectRun')}</p>
                </div>
              )}
            </article>
          </section>
        </>
      ) : null}

      {currentView === 'settings' ? (
        <>
          {settingsView === 'root' ? (
            <section className="grid settings-grid">
              <article className="panel setting-card" onClick={() => setSettingsView('account')}>
                <p className="section-label">{tr('cloudAccount')}</p>
                <h2>{tr('accountSettingsTitle')}</h2>
                <p className="lede">{tr('accountSettingsDescription')}</p>
              </article>
              <article className="panel setting-card" onClick={() => setSettingsView('openai')}>
                <p className="section-label">{tr('openAi')}</p>
                <h2>{tr('apiKeyAndModel')}</h2>
                <p className="lede">{tr('openAiSettingsDescription')}</p>
              </article>
            </section>
          ) : null}

          {settingsView !== 'root' ? (
            <section className="grid">
              <article className="panel panel-wide">
                <div className="panel-head">
                  <div>
                    <p className="section-label">{tr('settings')}</p>
                    <h2>{settingsView === 'account' ? tr('accountSettingsTitle') : tr('apiKeyAndModel')}</h2>
                  </div>
                  <button className="ghost-button compact" onClick={() => setSettingsView('root')}>{tr('backToSettings')}</button>
                </div>

                {settingsView === 'account' ? (
                  <>
                    <div className="form-grid">
                      <label className="wide">
                        Email
                        <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
                      </label>
                      <label className="wide">
                        Password
                        <input
                          type="password"
                          value={authPassword}
                          onChange={(event) => setAuthPassword(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="button-row">
                      <button className="primary-button" disabled={isAuthLoading} onClick={() => void handleLogin()}>
                        {isAuthLoading ? 'Working...' : 'Sign in'}
                      </button>
                      <button className="ghost-button" disabled={isAuthLoading} onClick={() => void handleRegister()}>
                        Create account
                      </button>
                      {userSession ? (
                        <>
                          <button className="ghost-button" onClick={() => void syncFromCloud(userSession.token)}>
                            Sync from cloud
                          </button>
                          <button className="ghost-button" onClick={handleSignOut}>
                            Sign out
                          </button>
                        </>
                      ) : null}
                    </div>

                    <p className="status-line muted">
                      {userSession ? `Signed in as ${userSession.user.email}` : 'Not signed in. Local mode only.'}
                    </p>
                    {authStatus ? <p className="status-line muted">{authStatus}</p> : null}
                  </>
                ) : null}

                {settingsView === 'openai' ? (
                  <>
                    <div className="panel-head inline-actions">
                      <div>
                        <p className="section-label">{tr('openAi')}</p>
                        <p className="muted">{tr('openAiSettingsDescription')}</p>
                      </div>
                      <button
                        className="ghost-button compact"
                        disabled={isRefreshingModels}
                        onClick={() => void refreshModels()}
                      >
                        {isRefreshingModels ? tr('refreshing') : tr('refreshModels')}
                      </button>
                    </div>

                    <div className="form-grid">
                      <label>
                        {tr('learningTarget')}
                        <select
                          value={openAiSettings.targetLevel}
                          onChange={(event) =>
                            setOpenAiSettings((current) => ({
                              ...current,
                              targetLevel: event.target.value as OpenAiSettings['targetLevel'],
                            }))
                          }
                        >
                          {jlptLevels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tr('language')}
                        <select
                          value={openAiSettings.language}
                          onChange={(event) =>
                            setOpenAiSettings((current) => ({
                              ...current,
                              language: event.target.value as LanguageCode,
                            }))
                          }
                        >
                          <option value="en">{tr('english')}</option>
                          <option value="zh-CN">{tr('chinese')}</option>
                          <option value="ja">{tr('japanese')}</option>
                        </select>
                      </label>
                      <label className="wide">
                        {tr('apiKey')}
                        <input
                          type="password"
                          value={openAiSettings.apiKey}
                          onChange={(event) =>
                            setOpenAiSettings((current) => ({
                              ...current,
                              apiKey: event.target.value,
                            }))
                          }
                          placeholder="sk-..."
                        />
                      </label>
                      <label className="wide">
                        {tr('model')}
                        <select
                          value={openAiSettings.selectedModel}
                          onChange={(event) =>
                            setOpenAiSettings((current) => ({
                              ...current,
                              selectedModel: event.target.value,
                            }))
                          }
                        >
                          {openAiSettings.availableModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="button-row">
                      <button className="primary-button" onClick={() => void handleSaveCloudSettings()}>
                        {tr('saveCloudSettings')}
                      </button>
                    </div>

                    <p className="status-line muted">
                      {tr('latestSync')}:{' '}
                      {openAiSettings.lastSyncedAt ? formatDate(openAiSettings.lastSyncedAt, language) : tr('notSyncedYet')}
                    </p>
                    <p className="status-line muted">
                      {tr('storedApiKey')}: {hasStoredApiKey ? tr('configured') : tr('missing')}
                    </p>
                  </>
                ) : null}
              </article>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  )
}

function OrderQuestionView({
  language,
  question,
  answer,
  onAdd,
  onRemove,
}: {
  language: LanguageCode
  question: OrderSelectQuestion
  answer: SessionAnswer | undefined
  onAdd: (question: OrderSelectQuestion, fragment: string) => void
  onRemove: (question: OrderSelectQuestion, index: number) => void
}) {
  const selected = Array.isArray(answer) ? answer : []
  const available = question.fragments.filter((fragment) => !selected.includes(fragment))

  return (
    <div className="order-shell">
      <div className="sequence-zone">
        <p className="section-label">{t(language, 'yourSequence')}</p>
        <div className="fragment-list">
          {selected.length ? (
            selected.map((fragment, index) => (
              <button
                key={`${fragment}-${index}`}
                className="fragment selected"
                onClick={() => onRemove(question, index)}
              >
                {fragment}
              </button>
            ))
          ) : (
            <p className="muted">{t(language, 'tapFragments')}</p>
          )}
        </div>
      </div>

      <div className="sequence-zone">
        <p className="section-label">{t(language, 'availableFragments')}</p>
        <div className="fragment-list">
          {available.map((fragment) => (
            <button
              key={fragment}
              className="fragment"
              onClick={() => onAdd(question, fragment)}
            >
              {fragment}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
