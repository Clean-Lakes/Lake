CREATE TABLE strategyLearningTurns(
 sourceId TEXT PRIMARY KEY REFERENCES strategySourceEvents(id),projectId TEXT NOT NULL REFERENCES projects(id),sessionId TEXT NOT NULL,turnId TEXT NOT NULL,
 userMessageId TEXT NOT NULL,userHash TEXT NOT NULL,snapshotJSON TEXT NOT NULL,snapshotHash TEXT NOT NULL,modelRef TEXT NOT NULL,
 globalEpoch INTEGER NOT NULL,projectEpoch INTEGER NOT NULL,createdAt TEXT NOT NULL,
 UNIQUE(sessionId,turnId)
);
CREATE TABLE strategyProposalRuns(
 jobId TEXT PRIMARY KEY REFERENCES strategyJobs(id),runtimeId TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown')),
 requestHash TEXT NOT NULL,leaseHash TEXT NOT NULL,resultJSON TEXT NOT NULL DEFAULT '',usageJSON TEXT NOT NULL DEFAULT '{}',errorCode TEXT NOT NULL DEFAULT '',startedAt TEXT NOT NULL,finishedAt TEXT NOT NULL DEFAULT ''
);
CREATE TRIGGER strategyLearningTurns_immutable BEFORE UPDATE ON strategyLearningTurns WHEN
 NEW.sourceId<>OLD.sourceId OR NEW.projectId<>OLD.projectId OR NEW.sessionId<>OLD.sessionId OR NEW.turnId<>OLD.turnId OR NEW.userMessageId<>OLD.userMessageId OR NEW.userHash<>OLD.userHash OR NEW.snapshotHash<>OLD.snapshotHash OR NEW.modelRef<>OLD.modelRef OR NEW.globalEpoch<>OLD.globalEpoch OR NEW.projectEpoch<>OLD.projectEpoch OR NEW.createdAt<>OLD.createdAt OR (NEW.snapshotJSON<>OLD.snapshotJSON AND NEW.snapshotJSON<>'')
 BEGIN SELECT RAISE(ABORT,'immutable learning source'); END;
CREATE TRIGGER strategyProposalRuns_settled BEFORE UPDATE ON strategyProposalRuns WHEN
 NEW.jobId<>OLD.jobId OR NEW.runtimeId<>OLD.runtimeId OR NEW.requestHash<>OLD.requestHash OR NEW.leaseHash<>OLD.leaseHash OR NEW.startedAt<>OLD.startedAt OR (OLD.status<>'running' AND (NEW.status<>OLD.status OR (NEW.resultJSON<>OLD.resultJSON AND NEW.resultJSON<>'') OR NEW.usageJSON<>OLD.usageJSON OR NEW.errorCode<>OLD.errorCode OR NEW.finishedAt<>OLD.finishedAt))
 BEGIN SELECT RAISE(ABORT,'settled proposal run'); END;

CREATE INDEX strategyLearningTurns_project ON strategyLearningTurns(projectId,createdAt,sourceId);
