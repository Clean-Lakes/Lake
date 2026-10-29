package web

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
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
			_, err = db.Exec("DROP TABLE strategyUsageFeedback;DROP TABLE strategyReusePolicies;DROP TABLE IF EXISTS legacyAssetArchive;DROP TABLE IF EXISTS legacyAssetSettingsArchive;DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=5),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(5,?)", strategySchemaV5Hash())
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
			want := 7
			if broken {
				want = 5
			}
			if version != want {
				t.Fatal("nontransactional migration", version)
			}
		})
	}
}
