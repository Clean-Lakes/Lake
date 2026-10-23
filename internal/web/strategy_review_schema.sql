CREATE TABLE strategyReviews(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
 decisionRevision INTEGER NOT NULL CHECK(decisionRevision>0),reasonCode TEXT NOT NULL,updatedAt TEXT NOT NULL,
 PRIMARY KEY(assetId,revision),FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TABLE strategyAssessments(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(assetId,revision),
 FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TRIGGER strategyAssessments_immutable BEFORE UPDATE ON strategyAssessments BEGIN SELECT RAISE(ABORT,'immutable assessment'); END;
CREATE TABLE strategyPromotions(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,originAssetId TEXT NOT NULL,originRevision INTEGER NOT NULL,originHash TEXT NOT NULL,
 PRIMARY KEY(assetId,revision),FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision),
 FOREIGN KEY(originAssetId,originRevision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TRIGGER strategyPromotions_immutable_update BEFORE UPDATE ON strategyPromotions BEGIN SELECT RAISE(ABORT,'immutable promotion'); END;
CREATE TRIGGER strategyPromotions_immutable_delete BEFORE DELETE ON strategyPromotions BEGIN SELECT RAISE(ABORT,'immutable promotion'); END;
CREATE TABLE strategyRejections(
 scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),sourceSetHash TEXT NOT NULL,contentHash TEXT NOT NULL,reasonCode TEXT NOT NULL,createdAt TEXT NOT NULL,
 PRIMARY KEY(scopeKey,sourceSetHash,contentHash)
);
-- Existing adoption is retained as an explicit historical user decision.
INSERT INTO strategyReviews SELECT DISTINCT r.assetId,r.revision,'accepted',1,'legacy_adoption',r.createdAt FROM strategyRevisions r JOIN strategyBindings b ON b.assetId=r.assetId AND b.revision=r.revision;
