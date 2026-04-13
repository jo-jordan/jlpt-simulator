import type { QuizResultRecord } from '../../src/types'

type ResultRow = {
  result_json: string
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export async function loadUserResultRecords(db: D1Database, userId: string) {
  const rows = await db
    .prepare('SELECT result_json FROM user_quiz_result_records WHERE user_id = ? ORDER BY submitted_at DESC')
    .bind(userId)
    .all<ResultRow>()

  return (rows.results ?? [])
    .map((row) => parseJson<QuizResultRecord>(row.result_json))
    .filter((record): record is QuizResultRecord => Boolean(record))
}

export async function saveUserResultRecord(db: D1Database, userId: string, record: QuizResultRecord) {
  await db
    .prepare(
      `INSERT INTO user_quiz_result_records (
        user_id,
        result_id,
        quiz_set_id,
        quiz_title,
        score_percent,
        correct_count,
        question_count,
        wrong_count,
        duration_ms,
        started_at,
        submitted_at,
        created_at,
        result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, result_id) DO UPDATE SET
        quiz_set_id = excluded.quiz_set_id,
        quiz_title = excluded.quiz_title,
        score_percent = excluded.score_percent,
        correct_count = excluded.correct_count,
        question_count = excluded.question_count,
        wrong_count = excluded.wrong_count,
        duration_ms = excluded.duration_ms,
        started_at = excluded.started_at,
        submitted_at = excluded.submitted_at,
        result_json = excluded.result_json`,
    )
    .bind(
      userId,
      record.id,
      record.quizSetId,
      record.quizTitle,
      record.scorePercent,
      record.correctCount,
      record.questionCount,
      record.incorrectQuestions.length,
      record.durationMs,
      record.startedAt,
      record.submittedAt,
      new Date().toISOString(),
      JSON.stringify(record),
    )
    .run()

  return record
}
