CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY CHECK(version=1)) STRICT;
INSERT OR IGNORE INTO schema_version VALUES(1);
CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(stream_id,sequence)) STRICT;
