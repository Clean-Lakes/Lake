CREATE TABLE naturalRecallMeta(version INTEGER PRIMARY KEY CHECK(version=1),schemaHash TEXT NOT NULL);
CREATE TABLE naturalRecallSettings(scopeKey TEXT PRIMARY KEY REFERENCES strategyScopes(scopeKey),revision INTEGER NOT NULL,useEnabled INTEGER NOT NULL CHECK(useEnabled IN (0,1)));
