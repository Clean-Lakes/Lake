CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=1),schemaHash TEXT NOT NULL);
CREATE TABLE strategyScopes(
 scopeKey TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('user','project')),
 projectId TEXT UNIQUE REFERENCES projects(id),owner TEXT NOT NULL CHECK(owner='local'),generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 CHECK((kind='user' AND projectId IS NULL AND scopeKey='user') OR (kind='project' AND projectId IS NOT NULL AND scopeKey='project:'||projectId))
);
INSERT INTO strategyScopes(scopeKey,kind,projectId,owner) VALUES('user','user',NULL,'local');
CREATE TABLE strategySettings(
 scopeKey TEXT PRIMARY KEY REFERENCES strategyScopes(scopeKey),revision INTEGER NOT NULL CHECK(revision>0),epoch INTEGER NOT NULL CHECK(epoch>0),
 body TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE TABLE strategyAssets(
 id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),kind TEXT NOT NULL CHECK(kind IN ('user_preference','domain_procedure','tool_guidance','report_guidance')),
 title TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),createdAt TEXT NOT NULL,deletedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX strategyAssets_scope ON strategyAssets(scopeKey,deletedAt,id);
CREATE TABLE strategySourceEvents(
 id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),originKey TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('manual_authoring','user_correction','tool_result','task_outcome','fixture_evaluation','skill_import')),
 sessionId TEXT NOT NULL DEFAULT '',messageId TEXT NOT NULL DEFAULT '',contentHash TEXT NOT NULL,summary TEXT NOT NULL,
 availability TEXT NOT NULL CHECK(availability IN ('available','tombstoned','revoked')),createdAt TEXT NOT NULL,
 UNIQUE(scopeKey,originKey)
);
CREATE TABLE strategyRevisions(
 assetId TEXT NOT NULL REFERENCES strategyAssets(id),revision INTEGER NOT NULL CHECK(revision>0),parentRevision INTEGER NOT NULL,
 applicabilityHash TEXT NOT NULL,contentHash TEXT NOT NULL,sourceSetHash TEXT NOT NULL,
 verification TEXT NOT NULL CHECK(verification IN ('user_confirmed','single_observation','fixture_validated','multi_task_validated')),
 createdBy TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(assetId,revision),
 CHECK((revision=1 AND parentRevision=0) OR (revision>1 AND parentRevision>0 AND parentRevision<revision))
);
CREATE TABLE strategyRevisionContent(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,applicability TEXT NOT NULL,PRIMARY KEY(assetId,revision),
 FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TABLE strategyRevisionSources(
 assetId TEXT NOT NULL,revision INTEGER NOT NULL,sourceId TEXT NOT NULL REFERENCES strategySourceEvents(id),
 PRIMARY KEY(assetId,revision,sourceId),FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TABLE strategyBindings(
 assetId TEXT NOT NULL REFERENCES strategyAssets(id),scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),revision INTEGER NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),bindingRevision INTEGER NOT NULL CHECK(bindingRevision>0),
 priority INTEGER NOT NULL,exclusionGroup TEXT NOT NULL,PRIMARY KEY(assetId,scopeKey),
 FOREIGN KEY(assetId,revision) REFERENCES strategyRevisions(assetId,revision)
);
CREATE TABLE strategyLineageNodes(
 id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),kind TEXT NOT NULL CHECK(kind IN ('user_message','task','plan_revision','run','attempt','tool_call','operation','evidence','correction','asset_revision','evaluation','adoption')),
 aggregateId TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,sourceId TEXT REFERENCES strategySourceEvents(id),createdAt TEXT NOT NULL
);
CREATE TABLE strategyLineageEdges(
 id INTEGER PRIMARY KEY AUTOINCREMENT,aggregateId TEXT NOT NULL REFERENCES strategyAssets(id),
 fromId TEXT NOT NULL REFERENCES strategyLineageNodes(id),toId TEXT NOT NULL REFERENCES strategyLineageNodes(id),
 relation TEXT NOT NULL CHECK(relation IN ('derived_from','proposed_to_fix','tested_by','compared_with','composed_from','adopted_as','supersedes','reverted_to')),
 actor TEXT NOT NULL,createdAt TEXT NOT NULL,CHECK(fromId<>toId),UNIQUE(aggregateId,fromId,toId,relation)
);
CREATE INDEX strategyLineageEdges_page ON strategyLineageEdges(aggregateId,id);
CREATE TABLE strategyJobs(
 id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),accessProjectId TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('proposal','experiment')),assetId TEXT REFERENCES strategyAssets(id),expectedRevision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','leased','awaiting_reconciliation','succeeded','failed','cancelled')),
 globalEpoch INTEGER NOT NULL,projectEpoch INTEGER NOT NULL,sourceSetHash TEXT NOT NULL,
 leaseToken TEXT NOT NULL DEFAULT '',leaseUntilMs INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
 runtimeId TEXT UNIQUE NOT NULL,dispatchState TEXT NOT NULL CHECK(dispatchState IN ('none','intent','started','unknown','complete')),
 expiresAtMs INTEGER NOT NULL,errorCode TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE INDEX strategyJobs_claim ON strategyJobs(accessProjectId,status,createdAt,id);
CREATE TABLE strategyJobSources(jobId TEXT NOT NULL REFERENCES strategyJobs(id),sourceId TEXT NOT NULL REFERENCES strategySourceEvents(id),PRIMARY KEY(jobId,sourceId));
CREATE TABLE strategyEvents(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),accessProjectId TEXT NOT NULL,
 aggregateId TEXT NOT NULL,revision INTEGER NOT NULL,type TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL,
 createdAt TEXT NOT NULL,publishedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX strategyEvents_outbox ON strategyEvents(publishedAt,seq);
CREATE TABLE strategyReceipts(
 scopeKey TEXT NOT NULL REFERENCES strategyScopes(scopeKey),keyHash TEXT NOT NULL,requestHash TEXT NOT NULL,result TEXT NOT NULL,
 PRIMARY KEY(scopeKey,keyHash)
);
CREATE TRIGGER strategyRevisions_immutable_update BEFORE UPDATE ON strategyRevisions BEGIN SELECT RAISE(ABORT,'immutable strategy revision'); END;
CREATE TRIGGER strategyRevisions_immutable_delete BEFORE DELETE ON strategyRevisions BEGIN SELECT RAISE(ABORT,'immutable strategy revision'); END;
CREATE TRIGGER strategyRevisionContent_immutable BEFORE UPDATE ON strategyRevisionContent BEGIN SELECT RAISE(ABORT,'immutable strategy content'); END;
CREATE TRIGGER strategyRevisionSources_immutable_update BEFORE UPDATE ON strategyRevisionSources BEGIN SELECT RAISE(ABORT,'immutable strategy sources'); END;
CREATE TRIGGER strategyRevisionSources_immutable_delete BEFORE DELETE ON strategyRevisionSources BEGIN SELECT RAISE(ABORT,'immutable strategy sources'); END;
CREATE TRIGGER strategyEdges_immutable_update BEFORE UPDATE ON strategyLineageEdges BEGIN SELECT RAISE(ABORT,'immutable strategy edge'); END;
CREATE TRIGGER strategyEdges_immutable_delete BEFORE DELETE ON strategyLineageEdges BEGIN SELECT RAISE(ABORT,'immutable strategy edge'); END;

CREATE TRIGGER strategyEvents_immutable_update BEFORE UPDATE ON strategyEvents WHEN
 NEW.seq<>OLD.seq OR NEW.scopeKey<>OLD.scopeKey OR NEW.accessProjectId<>OLD.accessProjectId OR NEW.aggregateId<>OLD.aggregateId OR
 NEW.revision<>OLD.revision OR NEW.type<>OLD.type OR NEW.actor<>OLD.actor OR NEW.digest<>OLD.digest OR NEW.createdAt<>OLD.createdAt OR
 (OLD.publishedAt<>'' AND NEW.publishedAt<>OLD.publishedAt)
 BEGIN SELECT RAISE(ABORT,'immutable strategy event'); END;
CREATE TRIGGER strategyEvents_immutable_delete BEFORE DELETE ON strategyEvents BEGIN SELECT RAISE(ABORT,'immutable strategy event'); END;
CREATE TRIGGER strategySourceEvents_immutable_update BEFORE UPDATE ON strategySourceEvents WHEN
 NEW.id<>OLD.id OR NEW.scopeKey<>OLD.scopeKey OR NEW.originKey<>OLD.originKey OR NEW.kind<>OLD.kind OR
 NEW.sessionId<>OLD.sessionId OR NEW.messageId<>OLD.messageId OR NEW.contentHash<>OLD.contentHash OR NEW.createdAt<>OLD.createdAt OR
 (NEW.summary<>OLD.summary AND NEW.summary<>'') OR (OLD.availability<>'available' AND NEW.availability='available')
 BEGIN SELECT RAISE(ABORT,'immutable strategy source'); END;
CREATE TRIGGER strategySourceEvents_immutable_delete BEFORE DELETE ON strategySourceEvents BEGIN SELECT RAISE(ABORT,'immutable strategy source'); END;

CREATE TRIGGER strategyAssets_immutable_identity BEFORE UPDATE ON strategyAssets WHEN
 NEW.id<>OLD.id OR NEW.scopeKey<>OLD.scopeKey OR NEW.kind<>OLD.kind OR NEW.createdAt<>OLD.createdAt OR
 NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1 OR (OLD.deletedAt<>'' AND NEW.deletedAt<>OLD.deletedAt)
 BEGIN SELECT RAISE(ABORT,'immutable strategy asset identity'); END;
