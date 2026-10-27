package web

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func learningSource(t *testing.T, s *Store, ctx StrategyContext) StrategyMutationResult {
	t.Helper()
	session := stringOf(s.CreateSession(ctx.ProjectID, "source", nil)["id"])
	msg := s.AddMessage(session, "user", "以后请先列出证据，再提出结论。", nil)
	result, err := s.RegisterStrategyMessageSource(ctx, stringOf(msg["id"]), ident())
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func learningOutput(id, body string) string {
	return jsonText(strategyProposalResult{SchemaVersion: 1, Candidate: &strategyProposalCandidate{Title: "Evidence before conclusions", Kind: strategy.UserPreference, Body: body, Reason: "The user explicitly requested an evidence-first answer; effectiveness is unverified.", SourceIDs: []string{id}}})
}
func TestStrategyLearningStrictResultSchema(t *testing.T) {
	good := learningOutput("actual", "Use concise reports.")
	if _, err := parseStrategyProposal(good, []string{"actual"}); err != nil {
		t.Fatal(err)
	}
	if _, err := parseStrategyProposal(`{"schemaVersion":1,"candidate":null}`, nil); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{good + " {}", strings.Replace(good, `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1), strings.Replace(good, `"body":`, `"Body":`, 1), strings.Replace(good, `"reason":`, `"verification":"observed","reason":`, 1), strings.Replace(good, "actual", "forged", 1), `{"schemaVersion":1}`, `{"schemaVersion":1,"candidate":{"title":"x"}}`, strings.Replace(good, "Use concise reports.", strings.Repeat("x", 4001), 1)} {
		if _, err := parseStrategyProposal(bad, []string{"actual"}); err == nil {
			t.Fatal("accepted malformed/forged result")
		}
	}
}
func TestStrategyLearningV1UpgradeBackupAndNoSecondBackup(t *testing.T) {
	dir := t.TempDir()
	db, err := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{schema, presentationSchema, memorySchema, strategySchema} {
		if _, err = db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec("INSERT INTO strategySchemaMeta VALUES(1,?)", strategySchemaV1Hash()); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v2-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("v1 backup missing")
	}
	snapshot, _ := openSQLite(backups[0])
	defer snapshot.Close()
	var version int
	var hash string
	snapshot.QueryRow("SELECT version,schemaHash FROM strategySchemaMeta").Scan(&version, &hash)
	if version != 1 || hash != strategySchemaV1Hash() {
		t.Fatal("backup marker changed")
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	backups, _ = filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v2-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("duplicate backup")
	}
	s.db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if version != 6 {
		t.Fatal("upgrade missing")
	}
}
func TestStrategyRetiredSourceRegistrationDoesNotCaptureOldSnapshots(t *testing.T) {
	s, ctx, _ := strategyFixture(t)
	enableStrategyFixture(t, s)
	session := stringOf(s.CreateSession(ctx.ProjectID, "old outbox", nil)["id"])
	text := "以后请先列证据。"
	msg := s.AddMessage(session, "user", text, nil)
	effective, _ := s.EffectiveStrategySettings(ctx)
	snapshot := ai.SealStrategySnapshot(ai.StrategyTurnSnapshot{UserMessageID: stringOf(msg["id"]), SessionID: session, ProjectID: ctx.ProjectID, TurnID: "old-turn", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), FinishedAt: now(), GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch, Status: "completed", Profile: "core", UserText: text, Correction: true})
	for i := 0; i < 2; i++ {
		source, err := s.registerStrategyTurn(snapshot)
		if err != nil || source != "" {
			t.Fatal("retired outbox captured content", source, err)
		}
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyLearningTurns")["n"]) != 0 {
		t.Fatal("new learning source persisted")
	}
}
