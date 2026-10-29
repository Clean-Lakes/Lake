package ai

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestC3OrdinaryRequestsDoNotRequireOrWriteExperimentalManifests(t *testing.T) {
	var requests atomic.Int32
	m, done := fakeModel(t, func(_ int, _ map[string]any) any { requests.Add(1); return response("Normal task completed.") })
	defer done()
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	if e.RecordPromptDiagnostics {
		t.Fatal("ordinary engine opted into diagnostics")
	}
	if err = e.Configure("case", Config{Model: m, Profile: "core", Runtime: "local"}); err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Exec("CREATE TRIGGER no_manifest BEFORE INSERT ON native_artifacts WHEN NEW.file_name LIKE 'prompt-manifest-%' BEGIN SELECT RAISE(ABORT,'optional diagnostics unavailable'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "Explain this without operations.", nil); err != nil || requests.Load() != 1 {
		t.Fatal("ordinary task depends on diagnostic artifact", err, requests.Load())
	}
	var count int64
	store.DB.Model(&nativeArtifact{}).Where("file_name LIKE 'prompt-manifest-%'").Count(&count)
	if count != 0 {
		t.Fatal("ordinary request wrote experiment manifest")
	}
	s, _ := e.get("case")
	if s.state.Runtime.PromptManifest != nil {
		t.Fatal("stale manifest shown as current request")
	}
	h, _ := e.History("case")
	if len(h) < 3 || h[len(h)-1].Content != "Normal task completed." {
		t.Fatal("business history not saved")
	}
}

func TestC3RequiredCanonicalStorageFailureStillStopsDispatch(t *testing.T) {
	var requests atomic.Int32
	m, done := fakeModel(t, func(_ int, _ map[string]any) any { requests.Add(1); return response("must not happen") })
	defer done()
	e := engineFor(t, m, nil)
	e.RecordPromptDiagnostics = false
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Exec("DROP TABLE native_history_migrations").Error; err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "Do the normal task.", nil); err == nil || requests.Load() != 0 {
		t.Fatal("real canonical failure was swallowed", err, requests.Load())
	}
}

func TestC3ProductionRuntimeHasNoRetiredExecutionHooks(t *testing.T) {
	forbidden := map[string]bool{"onlineBeforeCall": true, "onlineReserve": true, "onlineSettle": true, "onlinePropose": true, "onlinePolicyTrace": true, "strategyExperimentRuntime": true, "collectStrategySnapshot": true, "MaterializeStrategySnapshot": true, "StrategyLearnEnabled": true, "StrategyCorrectEnabled": true, "StrategyBudget": true, "CorrectionGuard": true}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok && forbidden[id.Name] {
				t.Errorf("retired execution dependency %s in %s", id.Name, path)
			}
			return true
		})
	}
}
