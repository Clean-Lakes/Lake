package web

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func reviewCandidate(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope) (StrategyMutationResult, StrategyMutationResult) {
	t.Helper()
	source := learningSource(t, s, ctx)
	result := seedLegacyCandidate(t, s, ctx, scope, source.SourceID)

	return result, source
}
func promotionDraft() StrategyAssetInput {
	return StrategyAssetInput{Title: "Public evidence preference", Kind: strategy.UserPreference, Body: "PUBLIC_REVIEWED_BODY: distinguish facts from assumptions.", Applicability: strategy.Applicability{Profiles: []string{"core"}}, Assessment: strategy.Assessment{Conditions: "General readonly reports", Evidence: "User reviewed; effectiveness unverified", Limitations: "Not evidence of service recovery"}}
}
func acceptReview(t *testing.T, s *Store, ctx StrategyContext, ref strategy.RevisionRef) {
	t.Helper()
	v, err := s.GetStrategyRevision(ctx, ref.AssetID, ref.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReviewStrategyRevision(ctx, ref.AssetID, ident(), ref, v.Review.DecisionRevision, "accepted", "reviewed"); err != nil {
		t.Fatal(err)
	}
}
func TestStrategyReviewPromotionPrivacyExactVersionAndWithdrawal(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	candidate, source := reviewCandidate(t, s, ctx, scope)
	v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
	ref := v.Value.Ref
	if v.Review.Decision != "pending" {
		t.Fatal("candidate not pending")
	}
	if _, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "pending", ref, promotionDraft(), true); err == nil {
		t.Fatal("unreviewed promoted")
	}
	acceptReview(t, s, ctx, ref)
	if _, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "no-confirm", ref, promotionDraft(), false); err == nil {
		t.Fatal("missing confirmation accepted")
	}
	public, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "promote", ref, promotionDraft(), true)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "promote", ref, promotionDraft(), true)
	if err != nil || replay.AssetID != public.AssetID {
		t.Fatal("promotion not idempotent", err)
	}
	if _, err = s.PromoteStrategyRevision(ctx, candidate.AssetID, "duplicate", ref, promotionDraft(), true); err == nil {
		t.Fatal("duplicate promotion allowed")
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyBindings")["n"]) != 0 {
		t.Fatal("review/promotion adopted automatically")
	}
	b := StrategyContext{ProjectID: stringOf(s.CreateProject("Other project")["id"])}
	pv, err := s.GetStrategyRevision(b, public.AssetID, 1)
	if err != nil || pv.Value.Body != promotionDraft().Body || pv.Value.Verification != strategy.UserConfirmed {
		t.Fatal("approved version unavailable", err)
	}
	if strings.Contains(jsonText(pv), "PRIVATE_PROJECT_ONLY") || strings.Contains(jsonText(pv), source.SourceID) || strings.Contains(jsonText(pv), ctx.ProjectID) {
		t.Fatal("global view leaked private origin")
	}
	lineage, err := s.StrategyLineage(b, public.AssetID, 0, 50)
	if err != nil || !lineage.Redacted || strings.Contains(jsonText(lineage), candidate.AssetID) {
		t.Fatal("lineage did not redact private origin", err)
	}
	own, err := s.StrategyLineage(ctx, public.AssetID, 0, 50)
	if err != nil || own.Redacted {
		t.Fatal("origin owner cannot audit promotion", err)
	}
	if _, err = s.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "adopt", StrategyBindingInput{Action: "adopt", Ref: pv.Value.Ref}); err != nil {
		t.Fatal(err)
	}
	selected, err := s.resolveStrategyBindings(b, strategy.SelectionQuery{Profile: "core"}, nil, nil)
	if err != nil || len(selected.Assets) != 1 {
		t.Fatal("global reuse failed", err)
	}
	edit := promotionDraft()
	edit.Body += " Keep limitations visible."
	revised, err := s.ReviseStrategyAsset(StrategyContext{}, public.AssetID, "revise", 1, 1, edit)
	if err != nil || revised.Revision != 2 {
		t.Fatal("cannot edit promotion", err)
	}
	binding, _ := s.GetStrategyBinding(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, public.AssetID)
	if binding.Revision != 1 {
		t.Fatal("new version silently adopted")
	}
	if _, err = s.ForgetStrategySource(ctx, source.SourceID, "withdraw", true); err != nil {
		t.Fatal(err)
	}
	for _, revision := range []int64{1, 2} {
		gone, e := s.GetStrategyRevision(b, public.AssetID, revision)
		if e != nil || gone.Available || gone.SourcesAvailable || gone.Value.Body != "" || gone.Assessment != (strategy.Assessment{}) {
			t.Fatal("withdrawal leaked promoted content", e)
		}
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyRevisionContent WHERE assetId=?", public.AssetID)["n"]) != 0 {
		t.Fatal("promoted content retained")
	}
	if _, err = s.resolveStrategyBindings(b, strategy.SelectionQuery{Profile: "core"}, &selected.Selection, nil); err == nil {
		t.Fatal("frozen context survived withdrawal")
	}
	s.Close()
	reopened, err := OpenStore(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	gone, err := reopened.GetStrategyRevision(b, public.AssetID, 1)
	if err != nil || gone.Available {
		t.Fatal("restart restored withdrawn text", err)
	}
}
func TestStrategyReviewRejectionSuppressesSourceAndContent(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	candidate, source := reviewCandidate(t, s, ctx, scope)
	v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
	if _, err := s.ReviewStrategyRevision(ctx, candidate.AssetID, "reject", v.Value.Ref, 0, "rejected", "too_specific"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReviewStrategyRevision(ctx, candidate.AssetID, "reject-stale", v.Value.Ref, 0, "accepted", "reviewed"); err == nil {
		t.Fatal("stale decision accepted")
	}
	if _, err := s.BindStrategyAsset(ctx, scope, "adopt-rejected", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref}); err == nil {
		t.Fatal("rejected adopted")
	}
	if _, err := s.QueueStrategyProposal(ctx, "same-source", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}}); err == nil {
		t.Fatal("rejected source charged again")
	}
	other := learningSource(t, s, ctx)
	_, err := s.QueueStrategyProposal(ctx, "different-source", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{other.SourceID}})
	strategyCheckError(t, err, 410)

	if _, err = s.DeleteStrategyAsset(ctx, candidate.AssetID, "delete", 1); err != nil {
		t.Fatal(err)
	}
	if s.row("SELECT 1 FROM strategyRejections WHERE scopeKey=?", strategyScopeKey(scope)) == nil {
		t.Fatal("deletion erased rejection memory")
	}
}
func TestStrategyReviewEditPreservesSourcesAndRejectRevokesPromotion(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	candidate, source := reviewCandidate(t, s, ctx, scope)
	v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
	in := promotionDraft()
	revised, err := s.ReviseStrategyAsset(ctx, candidate.AssetID, "rewrite", 1, 1, in)
	if err != nil {
		t.Fatal(err)
	}
	v, _ = s.GetStrategyRevision(ctx, candidate.AssetID, revised.Revision)
	if !strings.Contains(jsonText(v.Value.SourceIDs), source.SourceID) {
		t.Fatal("edit disconnected provenance")
	}
	pub, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "promote", v.Value.Ref, in, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReviewStrategyRevision(ctx, candidate.AssetID, "reject", v.Value.Ref, 0, "rejected", "incorrect"); err != nil {
		t.Fatal(err)
	}
	gone, err := s.GetStrategyRevision(StrategyContext{}, pub.AssetID, 1)
	if err != nil || gone.Available {
		t.Fatal("rejection did not revoke promotion", err)
	}
}

func TestStrategyReviewV4MigrationPrivateBackupRollbackAndExistingAdoption(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(map[bool]string{false: "upgrade", true: "rollback"}[conflict], func(t *testing.T) {
			s, ctx, scope := strategyFixture(t)
			enableStrategyFixture(t, s)
			candidate, _ := reviewCandidate(t, s, ctx, scope)
			v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
			if _, err := s.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref}); err != nil {
				t.Fatal(err)
			}
			dir := s.Dir
			s.Close()
			db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			_, err := db.Exec("DROP TABLE strategyUsageFeedback; DROP TABLE strategyReusePolicies; DROP TABLE strategyReviews;DROP TABLE strategyAssessments;DROP TABLE strategyPromotions;DROP TABLE strategyRejections;DROP TABLE IF EXISTS legacyAssetArchive;DROP TABLE IF EXISTS legacyAssetSettingsArchive;DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=4),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(4,?)", strategySchemaV4Hash())
			if err != nil {
				t.Fatal(err)
			}
			if conflict {
				db.Exec("CREATE TABLE strategyPromotions(conflict INTEGER)")
			}
			db.Close()
			reopened, err := OpenStore(dir)
			if conflict {
				if err == nil {
					reopened.Close()
					t.Fatal("partial migration accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				got, _ := reopened.GetStrategyRevision(ctx, candidate.AssetID, 1)
				if got.Review.Decision != "accepted" || got.Value.Body != v.Value.Body {
					t.Fatal("legacy adoption changed")
				}
			}
			backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v5-*.sqlite"))
			if len(backups) != 1 {
				t.Fatal("missing v4 backup")
			}
			info, _ := os.Stat(backups[0])
			if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
				t.Fatal("backup permissions")
			}
			db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			defer db.Close()
			var version int
			db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
			want := 7
			if conflict {
				want = 4
			}
			if version != want {
				t.Fatal("nontransactional upgrade")
			}
		})
	}
}

func TestStrategyReviewArchiveCannotRevivePromotedContent(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	candidate, _ := reviewCandidate(t, s, ctx, scope)
	v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
	acceptReview(t, s, ctx, v.Value.Ref)
	pub, err := s.PromoteStrategyRevision(ctx, candidate.AssetID, "promote", v.Value.Ref, promotionDraft(), true)
	if err != nil {
		t.Fatal(err)
	}
	s.ArchiveNavigation("project", ctx.ProjectID)
	gone, err := s.GetStrategyRevision(StrategyContext{}, pub.AssetID, 1)
	if err != nil || gone.Available {
		t.Fatal("archived project retained promoted text", err)
	}
	if _, err = s.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "adopt-unavailable", StrategyBindingInput{Action: "adopt", Ref: gone.Value.Ref}); err == nil {
		t.Fatal("archived origin was adopted")
	}
	if _, err = s.resolveStrategyBindings(StrategyContext{}, strategy.SelectionQuery{Profile: "core"}, nil, nil); err != nil {
		t.Fatal("archived origin poisoned global selection", err)
	}
	s.RestoreNavigation("project", ctx.ProjectID)
	gone, err = s.GetStrategyRevision(StrategyContext{}, pub.AssetID, 1)
	if err != nil || gone.Available {
		t.Fatal("restore revived erased promotion", err)
	}
}

func TestStrategyReviewPromotionPreservesSkillPermissions(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	body := "A private project Skill work method."
	imported, err := s.importStrategySkill(ctx, scope, "import", "private-method", body, StrategyAssetInput{Title: "Method", Kind: strategy.UserPreference, Body: body, Applicability: strategy.Applicability{Profiles: []string{"core"}}})
	if err != nil {
		t.Fatal(err)
	}
	v, _ := s.GetStrategyRevision(ctx, imported.AssetID, 1)
	pub, err := s.PromoteStrategyRevision(ctx, imported.AssetID, "promote", v.Value.Ref, promotionDraft(), true)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := s.GetStrategyRevision(StrategyContext{}, pub.AssetID, 1)
	if _, err = s.BindStrategyAsset(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "adopt", StrategyBindingInput{Action: "adopt", Ref: p.Value.Ref}); err != nil {
		t.Fatal(err)
	}
	other := StrategyContext{ProjectID: stringOf(s.CreateProject("Other")["id"])}
	for _, mode := range []string{"denied", "changed", "unchanged"} {
		q := strategy.SelectionQuery{Profile: "core", SkillReadAllowed: mode != "denied"}
		selection, err := s.resolveStrategyBindings(other, q, nil, func(name, hash string) bool {
			return mode == "unchanged" && name == "private-method" && hash == strategy.ContentHash(body)
		})
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		if mode == "unchanged" {
			want = 1
		}
		if len(selection.Assets) != want {
			t.Fatal("promotion bypassed Skill boundary", mode)
		}
	}
}
