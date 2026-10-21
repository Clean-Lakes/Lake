ALTER TABLE strategyExperimentRuns ADD COLUMN variant TEXT NOT NULL DEFAULT '';
CREATE TRIGGER strategyExperimentRuns_variant BEFORE UPDATE ON strategyExperimentRuns WHEN NEW.variant<>OLD.variant
 BEGIN SELECT RAISE(ABORT,'immutable experiment variant'); END;
CREATE TABLE strategyOptimizations(
 jobId TEXT PRIMARY KEY REFERENCES strategyExperiments(jobId),stage INTEGER NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 7),
 stopReason TEXT NOT NULL DEFAULT '',noProgress INTEGER NOT NULL DEFAULT 0,progressStage INTEGER NOT NULL DEFAULT 0,activeMs INTEGER NOT NULL DEFAULT 0,
 activationStartedMs INTEGER NOT NULL DEFAULT 0,waitUntilMs INTEGER NOT NULL DEFAULT 0,
 summaryJSON TEXT NOT NULL DEFAULT '',savedRevision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE strategyOptimizationCalls(
 id TEXT PRIMARY KEY,experimentId TEXT NOT NULL REFERENCES strategyOptimizations(jobId),stage TEXT NOT NULL CHECK(stage IN ('propose','synthesize')),
 status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','running','completed','failed','unknown','not_executed')),
 requestHash TEXT NOT NULL DEFAULT '',resultJSON TEXT NOT NULL DEFAULT '',usageJSON TEXT NOT NULL DEFAULT '{}',
 reservedTokens INTEGER NOT NULL DEFAULT 0,errorCode TEXT NOT NULL DEFAULT '',startedAt TEXT NOT NULL DEFAULT '',finishedAt TEXT NOT NULL DEFAULT '',
 UNIQUE(experimentId,stage)
);
CREATE TRIGGER strategyOptimizationCalls_settled BEFORE UPDATE ON strategyOptimizationCalls WHEN
 NEW.id<>OLD.id OR NEW.experimentId<>OLD.experimentId OR NEW.stage<>OLD.stage OR
 (OLD.status NOT IN ('planned','running') AND (NEW.status<>OLD.status OR NEW.requestHash<>OLD.requestHash OR NEW.usageJSON<>OLD.usageJSON OR NEW.reservedTokens<>OLD.reservedTokens OR NEW.errorCode<>OLD.errorCode OR NEW.startedAt<>OLD.startedAt OR NEW.finishedAt<>OLD.finishedAt OR (NEW.resultJSON<>OLD.resultJSON AND NEW.resultJSON<>'')))
 BEGIN SELECT RAISE(ABORT,'settled optimization call'); END;
