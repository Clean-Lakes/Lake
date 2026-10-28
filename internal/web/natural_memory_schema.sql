CREATE TABLE naturalMemoryMeta(version INTEGER PRIMARY KEY CHECK(version=1),schemaHash TEXT NOT NULL);
CREATE TABLE naturalMemorySettings(
 scopeKey TEXT PRIMARY KEY REFERENCES strategyScopes(scopeKey),revision INTEGER NOT NULL,epoch INTEGER NOT NULL,
 autoEnabled INTEGER NOT NULL CHECK(autoEnabled IN (0,1)),consentVersion INTEGER NOT NULL
);
CREATE TABLE naturalMemoryLinks(
 scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),assetId TEXT NOT NULL REFERENCES strategyAssets(id),
 revision INTEGER NOT NULL,refRevision INTEGER NOT NULL,refHash TEXT NOT NULL,bindingHash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('mapped','undone')),updatedAt TEXT NOT NULL,
 PRIMARY KEY(scopeKey,assetId)
);
CREATE TABLE naturalMemoryChanges(
 id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,assetId TEXT NOT NULL,
 beforeJSON TEXT NOT NULL,afterJSON TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('carry','undo')),
 createdAt TEXT NOT NULL,undoneBy TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(scopeKey,assetId) REFERENCES naturalMemoryLinks(scopeKey,assetId)
);
CREATE TABLE naturalMemoryReceipts(
 scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),keyHash TEXT NOT NULL,requestHash TEXT NOT NULL,resultJSON TEXT NOT NULL,
 PRIMARY KEY(scopeKey,keyHash)
);
CREATE INDEX naturalMemoryChanges_scope ON naturalMemoryChanges(scopeKey,createdAt,id);
CREATE TRIGGER naturalMemoryChanges_immutable BEFORE UPDATE ON naturalMemoryChanges WHEN
 NEW.id<>OLD.id OR NEW.scopeKey<>OLD.scopeKey OR NEW.assetId<>OLD.assetId OR NEW.beforeJSON<>OLD.beforeJSON OR NEW.afterJSON<>OLD.afterJSON OR NEW.kind<>OLD.kind OR NEW.createdAt<>OLD.createdAt OR (OLD.undoneBy<>'' AND NEW.undoneBy<>OLD.undoneBy)
 BEGIN SELECT RAISE(ABORT,'immutable memory change'); END;
CREATE TRIGGER naturalMemoryChanges_no_delete BEFORE DELETE ON naturalMemoryChanges
 BEGIN SELECT RAISE(ABORT,'immutable memory change'); END;
CREATE TRIGGER naturalMemoryLinks_identity BEFORE UPDATE ON naturalMemoryLinks WHEN
 NEW.scopeKey<>OLD.scopeKey OR NEW.assetId<>OLD.assetId OR NEW.revision<>OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'immutable memory link identity'); END;
