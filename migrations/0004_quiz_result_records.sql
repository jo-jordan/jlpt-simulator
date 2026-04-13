CREATE TABLE IF NOT EXISTS user_quiz_result_records (
  user_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  quiz_set_id TEXT NOT NULL,
  quiz_title TEXT NOT NULL,
  score_percent INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  question_count INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (user_id, result_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_quiz_result_records_user_submitted
  ON user_quiz_result_records(user_id, submitted_at DESC);
