CREATE TABLE strategyReusePolicies(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,modelHash TEXT NOT NULL,toolHashes TEXT NOT NULL,
 PRIMARY KEY(assetId,revision),FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TRIGGER strategyReusePolicies_immutable BEFORE UPDATE ON strategyReusePolicies BEGIN SELECT RAISE(ABORT,'immutable reuse policy'); END;
CREATE TABLE strategyUsageFeedback(
 projectId TEXT NOT NULL REFERENCES projects(id),sessionId TEXT NOT NULL,requestId TEXT NOT NULL,assetId TEXT NOT NULL,revision INTEGER NOT NULL,contentHash TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('helpful','neutral','harmful','not_used')),feedbackRevision INTEGER NOT NULL,updatedAt TEXT NOT NULL,
 PRIMARY KEY(projectId,sessionId,requestId,assetId,revision),FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
