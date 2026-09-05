CREATE TABLE pings (
  instance    TEXT NOT NULL,
  day         TEXT NOT NULL,
  received_at TEXT NOT NULL,
  country     TEXT NOT NULL,
  schema      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  PRIMARY KEY (instance, day)
);
CREATE INDEX pings_day ON pings (day);
