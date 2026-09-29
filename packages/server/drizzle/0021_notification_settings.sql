CREATE TABLE notification_settings (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_type text NOT NULL,
 target_id text NOT NULL,
 level text,
 muted_until integer,
 suppress_everyone integer NOT NULL DEFAULT 0,
 suppress_roles integer NOT NULL DEFAULT 0,
 updated_at integer NOT NULL,
 PRIMARY KEY (user_id, target_type, target_id)
);
--> statement-breakpoint
CREATE INDEX idx_notification_settings_target ON notification_settings(target_id);
