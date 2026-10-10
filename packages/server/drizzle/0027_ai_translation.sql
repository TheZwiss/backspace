CREATE TABLE ai_translation_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted BLOB NOT NULL
);
--> statement-breakpoint
CREATE TABLE ai_translation_results (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_key TEXT NOT NULL,
  encrypted BLOB NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, result_key)
);
--> statement-breakpoint
CREATE INDEX idx_ai_translation_results_lru ON ai_translation_results(user_id, used_at);
--> statement-breakpoint
-- Accounts are normally soft-deleted: do not leave usable provider credentials behind.
CREATE TRIGGER purge_deleted_user_translation AFTER UPDATE OF is_deleted ON users
WHEN NEW.is_deleted = 1
BEGIN
  DELETE FROM ai_translation_settings WHERE user_id = NEW.id;
  DELETE FROM ai_translation_results WHERE user_id = NEW.id;
END;
