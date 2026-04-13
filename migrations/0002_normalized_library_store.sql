CREATE TABLE IF NOT EXISTS user_library_meta (
  user_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_vocabulary_entries (
  user_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  term TEXT NOT NULL,
  reading TEXT,
  meaning TEXT NOT NULL,
  item_type TEXT NOT NULL,
  source_title TEXT,
  updated_at TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (user_id, entry_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_vocabulary_entries_user_sort
  ON user_vocabulary_entries(user_id, sort_order);

CREATE TABLE IF NOT EXISTS user_grammar_entries (
  user_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  term TEXT NOT NULL,
  reading TEXT,
  meaning TEXT NOT NULL,
  item_type TEXT NOT NULL,
  source_title TEXT,
  updated_at TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (user_id, entry_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_grammar_entries_user_sort
  ON user_grammar_entries(user_id, sort_order);

CREATE TABLE IF NOT EXISTS user_generated_quizzes (
  user_id TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  duration_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  quiz_json TEXT NOT NULL,
  PRIMARY KEY (user_id, quiz_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_generated_quizzes_user_sort
  ON user_generated_quizzes(user_id, sort_order);
