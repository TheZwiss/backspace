CREATE TABLE soundboard_assets (id text PRIMARY KEY NOT NULL, data blob NOT NULL, duration_ms integer NOT NULL);
--> statement-breakpoint
CREATE TABLE soundboard_sounds (
  id text PRIMARY KEY NOT NULL,
  space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES soundboard_assets(id),
  creator_id text NOT NULL,
  name text NOT NULL,
  volume real NOT NULL DEFAULT 1,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_soundboard_space ON soundboard_sounds(space_id);
--> statement-breakpoint
UPDATE roles SET permissions = CAST((CAST(permissions AS INTEGER) | 402653184) AS TEXT) WHERE id = space_id AND permissions <> '' AND permissions NOT GLOB '*[^0-9]*';
--> statement-breakpoint
CREATE TRIGGER soundboard_asset_cleanup AFTER DELETE ON soundboard_sounds
BEGIN
  DELETE FROM soundboard_assets WHERE id = OLD.asset_id AND NOT EXISTS (SELECT 1 FROM soundboard_sounds WHERE asset_id = OLD.asset_id);
END;
