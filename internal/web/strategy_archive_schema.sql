-- V7: legacy asset rows are an archive. Original V1-V6 DDL/hashes stay intact.
-- Keep originals in place to preserve references, deletion tombstones and unknown ledgers.
CREATE TABLE legacyAssetArchive(
 assetId TEXT PRIMARY KEY REFERENCES strategyAssets(id),scopeKey TEXT NOT NULL,
 revision INTEGER NOT NULL,archivedAt TEXT NOT NULL
);
INSERT INTO legacyAssetArchive SELECT id,scopeKey,revision,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM strategyAssets;
CREATE TABLE legacyAssetSettingsArchive(
 scopeKey TEXT PRIMARY KEY,revision INTEGER NOT NULL,epoch INTEGER NOT NULL,
 body TEXT NOT NULL,updatedAt TEXT NOT NULL
);
INSERT INTO legacyAssetSettingsArchive SELECT scopeKey,revision,epoch,body,updatedAt FROM strategySettings;
CREATE TRIGGER legacyAssetArchive_no_update BEFORE UPDATE ON legacyAssetArchive BEGIN SELECT RAISE(ABORT,'immutable legacy archive'); END;
CREATE TRIGGER legacyAssetArchive_no_delete BEFORE DELETE ON legacyAssetArchive BEGIN SELECT RAISE(ABORT,'immutable legacy archive'); END;
CREATE TRIGGER legacyAssetSettingsArchive_no_update BEFORE UPDATE ON legacyAssetSettingsArchive BEGIN SELECT RAISE(ABORT,'immutable legacy settings archive'); END;
CREATE TRIGGER legacyAssetSettingsArchive_no_delete BEFORE DELETE ON legacyAssetSettingsArchive BEGIN SELECT RAISE(ABORT,'immutable legacy settings archive'); END;
