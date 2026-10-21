CREATE TABLE strategyExperiments(
 jobId TEXT PRIMARY KEY REFERENCES strategyJobs(id),frozenJSON TEXT NOT NULL,frozenHash TEXT NOT NULL,modelRef TEXT NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0,tokensCharged INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL
);
CREATE TABLE strategyExperimentRuns(
 id TEXT PRIMARY KEY,experimentId TEXT NOT NULL REFERENCES strategyExperiments(jobId),ordinal INTEGER NOT NULL,caseId TEXT NOT NULL,arm TEXT NOT NULL CHECK(arm IN ('baseline','assets')),repetition INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('planned','running','completed','failed','unknown','cancelled','not_executed')),runtimeId TEXT NOT NULL DEFAULT '',reportJSON TEXT NOT NULL DEFAULT '',startedAt TEXT NOT NULL DEFAULT '',finishedAt TEXT NOT NULL DEFAULT '',
 UNIQUE(experimentId,ordinal)
);
CREATE INDEX strategyExperimentRuns_parent ON strategyExperimentRuns(experimentId,ordinal);
CREATE TRIGGER strategyExperiments_immutable BEFORE UPDATE ON strategyExperiments WHEN
 NEW.jobId<>OLD.jobId OR NEW.frozenHash<>OLD.frozenHash OR NEW.modelRef<>OLD.modelRef OR NEW.createdAt<>OLD.createdAt OR (NEW.frozenJSON<>OLD.frozenJSON AND NEW.frozenJSON<>'') OR NEW.requests<OLD.requests
 BEGIN SELECT RAISE(ABORT,'immutable experiment input'); END;
CREATE TRIGGER strategyExperimentRuns_settled BEFORE UPDATE ON strategyExperimentRuns WHEN
 NEW.id<>OLD.id OR NEW.experimentId<>OLD.experimentId OR NEW.ordinal<>OLD.ordinal OR NEW.caseId<>OLD.caseId OR NEW.arm<>OLD.arm OR NEW.repetition<>OLD.repetition OR
 (OLD.status NOT IN ('planned','running') AND (NEW.status<>OLD.status OR NEW.runtimeId<>OLD.runtimeId OR NEW.startedAt<>OLD.startedAt OR NEW.finishedAt<>OLD.finishedAt OR (NEW.reportJSON<>OLD.reportJSON AND NEW.reportJSON<>'')))
 BEGIN SELECT RAISE(ABORT,'settled experiment run'); END;
