package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Explicit synthetic-source model verification; never runs in ordinary checks.
func TestNaturalConsolidationModelEvaluation(t *testing.T) {
	home := os.Getenv("LAKE_N3_EVAL_HOME")
	if home == "" {
		t.Skip("explicit Dev model evaluation only")
	}
	owner, _ := os.UserHomeDir()
	if filepath.Clean(home) != filepath.Join(owner, ".lake-dev") {
		t.Fatal("explicit Dev Home required")
	}
	reportPath := os.Getenv("LAKE_N3_EVAL_REPORT")
	if reportPath == "" {
		t.Fatal("report path required")
	}
	raw, e := os.ReadFile("testdata/natural-memory-intent-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != "922f2a4f4b30ae23ba5c178af1456a0a635fff69f1b37505b4bd4f62bc21f084" {
		t.Fatal("frozen corpus changed")
	}
	var data struct {
		Runs  int `json:"runs"`
		Cases []struct {
			ID       string `json:"id"`
			Text     string `json:"userText"`
			Expected struct {
				Decision    string `json:"decision"`
				Scope       string `json:"scope"`
				Replacement bool   `json:"replacement"`
			} `json:"expected"`
			Previous *struct {
				Body  string `json:"body"`
				Scope string `json:"scope"`
			} `json:"previousPreference"`
		} `json:"cases"`
	}
	if json.Unmarshal(raw, &data) != nil || len(data.Cases) != 60 || data.Runs != 3 {
		t.Fatal("bad fixed corpus")
	}
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	model := models.CachedCapacity(models.Active())
	if model == nil {
		t.Fatal("Dev model unavailable")
	}
	model.MaxOutput = 2048
	engine, e := ai.New(t.TempDir(), nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer engine.Shutdown()
	type outcome struct {
		Run       int      `json:"run"`
		ID        string   `json:"id"`
		Decision  string   `json:"decision"`
		Scope     string   `json:"scope"`
		Relation  string   `json:"relation"`
		Committed bool     `json:"committed"`
		Correct   bool     `json:"correct"`
		Error     string   `json:"error,omitempty"`
		Usage     ai.Usage `json:"usage"`
	}
	filter := os.Getenv("LAKE_N3_EVAL_DIAGNOSTIC_IDS")
	var dispatches atomic.Int32
	results := make([]outcome, 180)
	tasks := make(chan int)
	var workers sync.WaitGroup
	for n := 0; n < 4; n++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range tasks {
				c := data.Cases[index%60]
				r := outcome{Run: index/60 + 1, ID: c.ID}
				if filter != "" && (index >= 60 || !strings.Contains(","+filter+",", ","+c.ID+",")) {
					r.Error = "diagnostic_skipped"
					results[index] = r
					continue
				}
				dir, err := os.MkdirTemp("", "lake-n3-quality-")
				if err != nil {
					r.Error = "fixture_error"
					results[index] = r
					continue
				}
				func() {
					defer os.RemoveAll(dir)
					s, err := OpenStore(dir)
					if err != nil {
						r.Error = "fixture_error"
						return
					}
					defer s.Close()
					project := stringOf(s.CreateProject("N3 synthetic fixture")["id"])
					session := stringOf(s.CreateSession(project, "source", nil)["id"])
					ctx := StrategyContext{ProjectID: project}
					_, _ = s.SetNaturalMemorySettings(ctx, "project-consent", 0, true)
					_, _ = s.SetNaturalMemorySettings(StrategyContext{}, "global-consent", 0, true)
					if c.Previous != nil {
						old := s.AddMessage(session, "user", c.Previous.Body, nil)
						scope := "project:" + project
						if c.Previous.Scope == "user" {
							scope = "user"
						}
						id := ident()
						s.update(func() any {
							s.exec("INSERT INTO naturalPreferenceEntries VALUES(?,?,?,1,'active',?)", id, scope, "fixture-prior-preference", now())
							s.exec("INSERT INTO naturalPreferenceRevisions VALUES(?,1,0,?,?,?,?,?,?)", id, project, session, old["id"], memoryHash(c.Previous.Body), memoryHash(c.Previous.Body), now())
							s.exec("INSERT INTO naturalPreferenceContent VALUES(?,1,?)", id, c.Previous.Body)
							s.naturalAddSupport(id, 1, project, session, stringOf(old["id"]), memoryHash(c.Previous.Body), 1)
							return nil
						})
					}
					message := s.AddMessage(session, "user", c.Text, nil)
					snap := testMemorySnapshot(project, session, ident(), 0, 0)
					snap.UserText = c.Text
					snap.SourceMessageID = stringOf(message["id"])
					snap.Natural = s.NaturalConsent(project)
					snap = ai.SealMemorySnapshot(snap)
					if s.EnqueueMemoryTurn(snap) != nil {
						r.Error = "fixture_error"
						return
					}
					job := s.ClaimMemoryJob()
					items := []naturalBatchItem{{Job: job, Snapshot: snap}}
					existing := s.read(func() any { return s.naturalPreferenceIndex(snap) }).([]Object)
					guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
					callCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
					dispatches.Add(1)
					output, usage, err := engine.ExtractMemory(callCtx, *model, naturalConsolidationMessages(items, existing, ""))
					cancel()
					r.Usage = usage
					if err != nil {
						r.Error = "provider_error"
						return
					}
					parsed, err := parseNaturalConsolidation(output, items)
					if err != nil {
						r.Error = "invalid_output:" + err.Error()
						if ai.SafeMemoryContent(output, *model) && !models.strategyContainsProviderSecret(output) {
							_ = os.WriteFile(filepath.Join(os.TempDir(), "lake-n3-output-"+c.ID+".txt"), []byte(output), 0600)
						}
						return
					}
					p := parsed[0].Result
					r.Decision, r.Scope, r.Relation = p.Decision, p.Scope, p.Relation
					_, err = s.commitNaturalBatch(parsed, usage, existing, guard, ident())
					if err == nil && p.Decision == "save" && p.Relation != "conflict" {
						scope := "project:" + project
						if p.Scope == "user" {
							scope = "user"
						}
						s.read(func() any {
							entry := s.row("SELECT id FROM naturalPreferenceEntries WHERE scopeKey=? AND topic=?", scope, p.Topic)
							if entry != nil {
								view := s.naturalPreferenceView(scope, stringOf(entry["id"]), 0)
								r.Committed = view["state"] == "active" && view["body"] == p.Quote
							}
							return nil
						})
					}
					r.Correct = p.Decision == c.Expected.Decision && p.Scope == c.Expected.Scope && p.Replacement == c.Expected.Replacement
					if c.Expected.Decision == "save" {
						r.Correct = r.Correct && r.Committed
						if c.Previous != nil {
							r.Correct = r.Correct && p.Topic == "fixture-prior-preference" && p.Relation == "correction"
						}
					}
				}()
				results[index] = r
			}
		}()
	}
	for i := range results {
		tasks <- i
	}
	close(tasks)
	workers.Wait()
	summaries := []Object{}
	passed := true
	for run := 1; run <= 3; run++ {
		positive, falseWrites, wrongScopes, technical, exact := 0, 0, 0, 0, 0
		for i, r := range results {
			if r.Run != run {
				continue
			}
			c := data.Cases[i%60]
			if r.Error != "" {
				technical++
			}
			if r.Correct {
				exact++
			}
			if c.Expected.Decision == "save" && r.Correct {
				positive++
			}
			if r.Committed && c.Expected.Decision != "save" {
				falseWrites++
			}
			if r.Committed && r.Scope != c.Expected.Scope {
				wrongScopes++
			}
		}
		ok := positive >= 27 && falseWrites == 0 && wrongScopes == 0 && technical == 0
		passed = passed && ok
		summaries = append(summaries, Object{"run": run, "positiveRecallCount": positive, "positiveCount": 30, "falseAutoWrites": falseWrites, "wrongScopes": wrongScopes, "technicalFailures": technical, "exactDecisions": exact, "passed": ok})
	}
	report := Object{"schemaVersion": 1, "fixtureSHA256": hex.EncodeToString(sum[:]), "promptSHA256": memoryHash(naturalConsolidationMessages(nil, nil, "")[0].Content), "model": Object{"name": model.Name, "protocol": model.Protocol, "maxOutput": model.MaxOutput}, "providerDispatches": dispatches.Load(), "diagnostic": filter != "", "actual_store_transactions": true, "summaries": summaries, "passed": passed, "results": results}
	encoded, _ := json.MarshalIndent(report, "", "  ")
	if os.WriteFile(reportPath, encoded, 0600) != nil {
		t.Fatal("cannot write report")
	}
	t.Log(jsonText(summaries))
	if !passed {
		t.Fatal("frozen N3 intent thresholds not met")
	}
}

func TestNaturalConsolidationModelBatchEvaluation(t *testing.T) {
	home := os.Getenv("LAKE_N3_EVAL_HOME")
	if home == "" {
		t.Skip("explicit synthetic batch model evaluation only")
	}
	owner, _ := os.UserHomeDir()
	if filepath.Clean(home) != filepath.Join(owner, ".lake-dev") {
		t.Fatal("Dev Home required")
	}
	path := os.Getenv("LAKE_N3_BATCH_REPORT")
	if path == "" {
		t.Skip("explicit batch report required")
	}
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	model := models.CachedCapacity(models.Active())
	if model == nil {
		t.Fatal("model unavailable")
	}
	model.MaxOutput = 4096
	engine, e := ai.New(t.TempDir(), nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer engine.Shutdown()
	cases := []struct {
		id    string
		texts []string
		kind  string
	}{
		{"semantic-equivalent", []string{"以后这个项目的答复固定用中文。", "本项目后续的回复都使用中文。"}, "merge"},
		{"unclear-contradiction", []string{"以后这个项目的答复固定中文。", "以后这个项目的答复固定英文。"}, "conflict"},
		{"explicit-correction", []string{"以后这个项目的答复固定中文。", "更正本项目长期偏好：以后答复固定英文。"}, "correction"},
		{"scope-separated", []string{"以后这个项目的答复固定中文。", "所有项目以后固定使用英文。"}, "scopes"},
		{"quoted-and-temporary", []string{"请翻译文档原话：“以后本项目固定英文。”", "这次回答简短一点。"}, "ignore"},
		{"temporary-does-not-replace", []string{"以后这个项目的答复固定中文。", "这次回答使用英文。"}, "temporary"},
		{"different-conditions", []string{"以后本项目只在生产排障报告里先列风险。", "以后本项目只在开发排障报告里先列风险。"}, "conditions"},
		{"two-independent-topics", []string{"以后这个项目的答复固定中文。", "以后这个项目的报告固定先列风险。"}, "topics"},
	}
	results := []Object{}
	passed := true
	var total ai.Usage
	for run := 1; run <= 3; run++ {
		for _, c := range cases {
			func() {
				s, e := OpenStore(t.TempDir())
				if e != nil {
					t.Fatal(e)
				}
				defer s.Close()
				project := stringOf(s.CreateProject("N3 synthetic batch")["id"])
				session := stringOf(s.CreateSession(project, "batch", nil)["id"])
				ctx := StrategyContext{ProjectID: project}
				_, _ = s.SetNaturalMemorySettings(ctx, "project", 0, true)
				_, _ = s.SetNaturalMemorySettings(StrategyContext{}, "global", 0, true)
				var first ai.MemoryTurnSnapshot
				for i, text := range c.texts {
					snap := consolidationSource(t, s, ctx, session, text, false)
					if i == 0 {
						first = snap
					}
				}
				items := consolidationItems(t, s, first)
				guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
				call, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				output, usage, e := engine.ExtractMemory(call, *model, naturalConsolidationMessages(items, nil, ""))
				cancel()
				total.Input += usage.Input
				total.Output += usage.Output
				total.Total += usage.Total
				entry := Object{"run": run, "id": c.id, "sources": len(items), "usage": usage, "passed": false}
				defer func() { results = append(results, entry) }()
				if e != nil {
					entry["error"] = "provider_error"
					passed = false
					return
				}
				parsed, e := parseNaturalConsolidation(output, items)
				if e != nil {
					entry["error"] = "invalid_output:" + e.Error()
					passed = false
					return
				}
				_, commitErr := s.commitNaturalBatch(parsed, usage, nil, guard, ident())
				prefs, _ := s.NaturalFormedPreferences(ctx, "", 20)
				globals, _ := s.NaturalFormedPreferences(StrategyContext{}, "", 20)
				local := objects(prefs["items"])
				global := objects(globals["items"])
				ok := commitErr == nil
				switch c.kind {
				case "merge":
					ok = ok && len(local) == 1 && integer(local[0]["revision"]) == 2 && len(objects(local[0]["sources"])) == 2 && local[0]["state"] == "active"
				case "conflict":
					ok = ok && len(local) == 1 && local[0]["state"] == "conflict" && integer(local[0]["revision"]) == 1
				case "correction":
					ok = ok && len(local) == 1 && local[0]["state"] == "active" && local[0]["body"] == c.texts[1] && integer(local[0]["revision"]) == 2
				case "scopes":
					ok = ok && len(local) == 1 && len(global) == 1
					if ok {
						for _, source := range objects(global[0]["sources"]) {
							if source["sessionId"] != nil || source["messageId"] != nil {
								ok = false
							}
						}
					}
				case "ignore":
					ok = ok && len(local) == 0 && len(global) == 0
				case "temporary":
					ok = ok && len(local) == 1 && local[0]["body"] == c.texts[0] && integer(local[0]["revision"]) == 1
				case "conditions": // A conservative whole-batch defer is safe but explicitly remains uncovered.
					ok = len(local) == 2 || commitErr != nil && len(local) == 0 || len(local) == 1 && local[0]["state"] == "conflict"
				case "topics":
					ok = ok && len(local) == 2
				}
				entry["passed"], entry["committedPreferences"], entry["globalPreferences"] = ok, len(local), len(global)
				entry["transactionDeferred"] = commitErr != nil
				if !ok && ai.SafeMemoryContent(output, *model) && !models.strategyContainsProviderSecret(output) {
					_ = os.WriteFile(filepath.Join(os.TempDir(), "lake-n3-batch-output-"+c.id+".txt"), []byte(output), 0600)
				}
				passed = passed && ok
			}()
		}
	}
	report := Object{"schemaVersion": 1, "model": Object{"name": model.Name, "protocol": model.Protocol, "maxOutput": model.MaxOutput}, "promptSHA256": memoryHash(naturalConsolidationMessages(nil, nil, "")[0].Content), "runs": 3, "providerDispatches": len(results), "usage": total, "passed": passed, "results": results, "limitations": []string{"Synthetic two-source cases, one model. Condition mismatch may defer a whole batch; not complete coverage or positive learning.", "All accepted changes pass the real Store transaction. No tools or live environment operations."}}
	data, _ := json.MarshalIndent(report, "", "  ")
	if os.WriteFile(path, data, 0600) != nil {
		t.Fatal("cannot write report")
	}
	if !passed {
		t.Fatal("N3 semantic batch gates failed; inspect private report")
	}
}

func TestNaturalConsolidationExistingTargetModelEvaluation(t *testing.T) {
	home := os.Getenv("LAKE_N3_EVAL_HOME")
	path := os.Getenv("LAKE_N3_EXISTING_REPORT")
	if home == "" || path == "" {
		t.Skip("explicit synthetic existing-target evaluation only")
	}
	owner, _ := os.UserHomeDir()
	if filepath.Clean(home) != filepath.Join(owner, ".lake-dev") {
		t.Fatal("Dev Home required")
	}
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	model := models.CachedCapacity(models.Active())
	if model == nil {
		t.Fatal("model unavailable")
	}
	model.MaxOutput = 4096
	engine, e := ai.New(t.TempDir(), nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer engine.Shutdown()
	results := []Object{}
	passed := true
	for run := 1; run <= 3; run++ {
		for _, c := range []struct{ id, text, relation string }{
			{"existing-merge", "以后这个项目的答复一直用中文。", "equivalent"},
			{"existing-conflict", "以后这个项目的答复固定使用英文。", "conflict"},
			{"existing-correction", "更正本项目长期偏好：以后答复固定使用英文。", "correction"},
		} {
			func() {
				s, ctx, session := naturalNewFixture(t)
				a := consolidationSource(t, s, ctx, session, "以后这个项目的答复固定用中文。", false)
				items := consolidationItems(t, s, a)
				items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
				items[0].Result.Relation = "new"
				if _, e := consolidationCommit(t, s, items); e != nil {
					t.Fatal(e)
				}
				b := consolidationSource(t, s, ctx, session, "本项目后续的回复都使用中文。", false)
				items = consolidationItems(t, s, b)
				items[0].Result = naturalResult(b.UserText, "response-language", false, 1)
				items[0].Result.Relation = "equivalent"
				if _, e := consolidationCommit(t, s, items); e != nil {
					t.Fatal(e)
				}
				source := consolidationSource(t, s, ctx, session, c.text, false)
				items = consolidationItems(t, s, source)
				index := s.read(func() any { return s.naturalPreferenceIndex(source) }).([]Object)
				guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
				call, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				output, usage, e := engine.ExtractMemory(call, *model, naturalConsolidationMessages(items, index, ""))
				cancel()
				r := Object{"run": run, "id": c.id, "usage": usage, "passed": false}
				defer func() { results = append(results, r) }()
				if e != nil {
					r["error"] = "provider_error"
					passed = false
					return
				}
				parsed, e := parseNaturalConsolidation(output, items)
				if e != nil {
					r["error"] = "invalid_output:" + e.Error()
					passed = false
					if ai.SafeMemoryContent(output, *model) && !models.strategyContainsProviderSecret(output) {
						_ = os.WriteFile(filepath.Join(os.TempDir(), "lake-n3-existing-"+c.id+".txt"), []byte(output), 0600)
					}
					return
				}
				r["relation"] = parsed[0].Result.Relation
				_, e = s.commitNaturalBatch(parsed, usage, index, guard, ident())
				ok := e == nil && parsed[0].Result.Relation == c.relation
				r["passed"] = ok
				passed = passed && ok
			}()
		}
	}
	data, _ := json.MarshalIndent(Object{"passed": passed, "providerDispatches": len(results), "results": results}, "", "  ")
	if os.WriteFile(path, data, 0600) != nil {
		t.Fatal("report unavailable")
	}
	if !passed {
		t.Fatal("existing target gates failed; inspect private synthetic report")
	}
}
