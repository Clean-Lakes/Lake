package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStrategyReuseValidityModelToolsAndPendingConditions(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	for _, mode := range []string{"match", "unrelated", "expired", "review", "model", "tools"} {
		t.Run(mode, func(t *testing.T) {
			p := strategy.ReusePolicy{Keywords: []string{"磁盘"}}
			if mode == "expired" {
				p.ValidUntil = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
			}
			if mode == "review" {
				p.NeedsReview = true
			}
			in := StrategyAssetInput{Title: "Disk method", Kind: strategy.DomainProcedure, Body: "Method " + mode, Applicability: strategy.Applicability{Profiles: []string{"core"}}, Reuse: &p, ModelHash: "model-A", ToolHashes: map[string]string{"core": "tools-A"}}
			a, err := s.CreateStrategyAsset(ctx, scope, ident(), in)
			if err != nil {
				t.Fatal(err)
			}
			v, _ := s.GetStrategyRevision(ctx, a.AssetID, 1)
			if _, err = s.BindStrategyAsset(ctx, scope, ident(), StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref}); err != nil {
				t.Fatal(err)
			}
			q := strategy.SelectionQuery{Profile: "core", TaskText: "检查磁盘空间", ModelHash: "model-A", ToolHash: "tools-A"}
			if mode == "unrelated" {
				q.TaskText = "翻译一段文字"
			}
			if mode == "model" {
				q.ModelHash = "model-B"
			}
			if mode == "tools" {
				q.ToolHash = "tools-B"
			}
			result, err := s.resolveStrategyBindings(ctx, q, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "match" {
				if len(result.Assets) != 1 || result.Assets[0].Ref != v.Value.Ref {
					t.Fatal("matched version not selected")
				}
				return
			}
			reasons := map[string]string{}
			for _, o := range result.Selection.Omitted {
				reasons[o.Ref.AssetID] = o.Reason
			}
			expected := map[string]string{"unrelated": "not_relevant", "expired": "expired", "review": "review_required", "model": "model_changed", "tools": "tools_changed"}[mode]
			if reasons[a.AssetID] != expected {
				t.Fatal("missing exclusion cause", reasons, expected)
			}
		})
	}
}
func TestStrategyReuseActualManifestFeedbackScopeAndProjectStop(t *testing.T) {
	b, h := fixture(t)
	b.Engine.RecordPromptDiagnostics = true // Explicit historical diagnostics fixture.
	sid, resource := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(sid)["projectId"])}
	enableStrategyFixture(t, b.Store)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload Object
		_ = json.NewDecoder(r.Body).Decode(&payload)
		n := requests.Add(1)
		raw := jsonText(payload["messages"])
		if n == 1 && !strings.Contains(raw, "R4_REPORT_PREF") {
			t.Error("actual provider missing selected content")
		}
		if n == 2 && strings.Contains(raw, "R4_REPORT_PREF") {
			t.Error("project stop did not omit asset")
		}
		emitModel(w, "已按本次要求完成。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "reuse-fixture", Protocol: "openai"})
	in := StrategyAssetInput{Title: "Evidence reports", Kind: strategy.ReportGuidance, Body: "R4_REPORT_PREF: facts before conclusions", Applicability: strategy.Applicability{Profiles: []string{"core"}}, Reuse: &strategy.ReusePolicy{Keywords: []string{"报告"}}}
	a, err := b.Store.CreateStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "create", in)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := b.Store.GetStrategyRevision(StrategyContext{}, a.AssetID, 1)
	b.Store.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"asset_ref": resource}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "请给出简短报告。"}, 202)
	b.workers.Wait()
	records, err := b.Engine.StrategyUsageHistory(context.Background(), sid, "", 20)
	if err != nil || len(records) != 1 || len(records[0].SelectedAssets) != 1 || records[0].AssetSelectionReasons[0].Reason != "task_keyword" {
		t.Fatal("durable usage missing", err, len(records))
	}
	m := records[0]
	base := "/api/projects/" + ctx.ProjectID + "/strategy"
	page := strategyHTTP(t, h, "GET", base+"/usage?sessionId="+sid, "", "", 200)
	if strings.Contains(jsonText(page), in.Body) || len(objects(page["items"])) != 1 {
		t.Fatal("usage exposed body or lost identity")
	}
	// Ordinary feedback has CAS and idempotency without mutating adoption.
	helpful := Object{"sessionId": sid, "ref": v.Value.Ref, "expectedRevision": 0, "outcome": "helpful", "suspend": false}
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "helpful", jsonText(helpful), 200)
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "helpful", jsonText(helpful), 200)
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "stale-helpful", jsonText(helpful), 409)
	// An old request must never disable a newer adopted version. Failed feedback
	// rolls back too, so the following stop still expects feedback revision 1.
	if _, err = b.Store.ReviseStrategyAsset(StrategyContext{}, a.AssetID, "v2", 1, 1, in); err != nil {
		t.Fatal(err)
	}
	v2, _ := b.Store.GetStrategyRevision(StrategyContext{}, a.AssetID, 2)
	b.Store.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "adopt2", StrategyBindingInput{Action: "adopt", Ref: v2.Value.Ref, ExpectedRevision: 1})
	oldStop := Object{"sessionId": sid, "ref": v.Value.Ref, "expectedRevision": 1, "outcome": "harmful", "suspend": true}
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "old-stop", jsonText(oldStop), 409)
	b.Store.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "restore1", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref, ExpectedRevision: 2})
	input := Object{"sessionId": sid, "ref": v.Value.Ref, "expectedRevision": 1, "outcome": "harmful", "suspend": true}
	strategyHTTP(t, h, "POST", base+"/usage/forged/feedback", "forged", jsonText(input), 404)
	wrong := v.Value.Ref
	wrong.ContentHash = strategy.ContentHash("forged")
	input["ref"] = wrong
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "wrong-ref", jsonText(input), 409)
	input["ref"] = v.Value.Ref
	other := stringOf(b.Store.CreateProject("Other")["id"])
	strategyHTTP(t, h, "GET", "/api/projects/"+other+"/strategy/usage?sessionId="+sid, "", "", 404)
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "stop", jsonText(input), 200)
	strategyHTTP(t, h, "POST", base+"/usage/"+m.RequestID+"/feedback", "stale", jsonText(input), 409)
	binding, _ := b.Store.GetStrategyBinding(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, a.AssetID)
	if !binding.Enabled {
		t.Fatal("project feedback disabled global preference")
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "再给出一份报告。"}, 202)
	b.workers.Wait()
	if requests.Load() != 2 {
		t.Fatal("feedback added a model request")
	}
	records, err = b.Engine.StrategyUsageHistory(context.Background(), sid, "", 1)
	if err != nil || len(records) != 1 || len(records[0].SelectedAssets) != 0 {
		t.Fatal("stop missing in next manifest", err)
	}
	older, err := b.Engine.StrategyUsageHistory(context.Background(), sid, records[0].RequestID, 20)
	if err != nil || len(older) != 1 || older[0].RequestID != m.RequestID {
		t.Fatal("history cursor crossed identity", err)
	}
	saved, err := b.Engine.StrategyUsageRequest(context.Background(), sid, m.RequestID)
	if err != nil || saved.SelectedAssets[0] != v.Value.Ref {
		t.Fatal("old request identity lost", err)
	}
	// The original immutable manifest remains the audit after a source withdrawal.
	b.Store.ForgetStrategySource(StrategyContext{}, a.SourceID, "forget", true)
	if _, err = b.Engine.StrategyUsageRequest(context.Background(), sid, m.RequestID); err != nil {
		t.Fatal("audit lost on withdrawal", err)
	}
}
func TestStrategyReuseV5UpgradeBackupRollbackAndOldPolicy(t *testing.T) {
	for _, broken := range []bool{false, true} {
		t.Run(map[bool]string{false: "upgrade", true: "rollback"}[broken], func(t *testing.T) {
			s, ctx, scope := strategyFixture(t)
			a, err := s.CreateStrategyAsset(ctx, scope, "old", StrategyAssetInput{Title: "Old method", Kind: strategy.DomainProcedure, Body: "Old environment procedure", Applicability: strategy.Applicability{}})
			if err != nil {
				t.Fatal(err)
			}
			dir := s.Dir
			s.Close()
			db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			_, err = db.Exec("DROP TABLE strategyUsageFeedback;DROP TABLE strategyReusePolicies;DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=5),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(5,?)", strategySchemaV5Hash())
			if err != nil {
				t.Fatal(err)
			}
			if broken {
				db.Exec("CREATE TABLE strategyUsageFeedback(conflict INTEGER)")
			}
			db.Close()
			reopened, err := OpenStore(dir)
			if broken {
				if err == nil {
					reopened.Close()
					t.Fatal("partial migration accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				v, _ := reopened.GetStrategyRevision(ctx, a.AssetID, 1)
				if v.Reuse.Keywords == nil {
					t.Fatal("legacy keywords must serialize as array")
				}
				if !v.Reuse.NeedsReview {
					t.Fatal("legacy method silently trusted")
				}
			}
			backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v6-*.sqlite"))
			if len(backups) != 1 {
				t.Fatal("missing v5 backup")
			}
			db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			defer db.Close()
			var version int
			db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
			want := 6
			if broken {
				want = 5
			}
			if version != want {
				t.Fatal("nontransactional migration", version)
			}
		})
	}
}
