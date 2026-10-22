package web

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Opt-in provider smoke test. Read existing Dev model settings/secret files
// only; runtime state lives in a temporary home with no real resources.
func TestPlanModeLiveClarificationAndProposal(t *testing.T) {
	home := os.Getenv("LAKE_PLAN_LIVE_DEV_HOME")
	if home == "" {
		t.Skip("set LAKE_PLAN_LIVE_DEV_HOME to explicitly run a provider smoke test")
	}
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	model := models.Active()
	if model == nil {
		t.Fatal("Dev model is not configured")
	}
	t.Logf("provider smoke: model=%s protocol=%s", model.Name, model.Protocol)
	engine, err := ai.New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Shutdown()
	if err := engine.Configure("plan-live", ai.Config{Model: *model, Profile: "core", Runtime: "local", Workspace: t.TempDir(), ConversationMode: ai.ModePlan, MaxSteps: 6, Permissions: &ai.Permissions{DenyLocalExecution: true}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- engine.Chat(ctx, "plan-live", "这是隔离的产品功能测试，没有任何真实资源。请为一个虚构的 PostgreSQL 迁移制定完整性核对计划，不执行命令、SQL 或文件访问。检查范围是必须由用户决定的缺失条件：请先使用 ask_user_question 提供‘全部数据库’和‘指定数据库’两个范围选项，等待回答后再给出完整计划。", nil)
	}()
	answered := false
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal("live planning failed", err)
			}
			view, snapshotErr := engine.Snapshot("plan-live")
			plans, listErr := engine.ProposedPlans("plan-live")
			if snapshotErr != nil || listErr != nil || !answered || view.Status != "completed" || view.ProposedPlan == nil || len(plans) != 1 {
				t.Logf("status=%s answered=%t proposal=%t plans=%d", view.Status, answered, view.ProposedPlan != nil, len(plans))
				t.Fatal("live planning did not finish the clarification/proposal flow")
			}
			t.Log("live clarification answered; complete proposal persisted and appears in plan list")
			return
		case <-ctx.Done():
			t.Fatal("live planning smoke timed out")
		case <-time.After(200 * time.Millisecond):
			view, err := engine.Snapshot("plan-live")
			if err != nil {
				t.Fatal(err)
			}
			if !answered && view.Question != nil {
				if view.ProposedPlan != nil {
					t.Fatal("unanswered question became executable")
				}
				answers := map[string][]string{}
				for _, question := range view.Question.Questions {
					if len(question.Options) == 0 {
						t.Fatal("question has no choices")
					}
					answers[question.ID] = []string{question.Options[0].Label}
				}
				if err := engine.ReplyQuestion("plan-live", view.Question.ID, answers); err != nil {
					t.Fatal(err)
				}
				answered = true
				t.Log("live question surfaced; supplied synthetic test answer")
			}
		}
	}
}
