package ai

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestContextContractsUseFrozenRoleAndCanonicalAcceptance(t *testing.T) {
	e, b := superFixture(t)
	first := superCreateFixture(t, e, b, "first", "只读核对 A，不得重启", "a", "核对 A")
	configureContextRouter(t, e, b)
	assignment, err := e.BuildTaskAssignment(t.Context(), "pilot", first.TaskID)
	if err != nil || assignment.Validate() != nil || assignment.TaskID != first.TaskID || assignment.WorkerID != first.WorkerID || assignment.SessionID != first.SessionID || assignment.RoleRevision != 1 {
		t.Fatal(assignment, err)
	}
	c, _ := e.ConfigForSession("pilot")
	if c.superRouter.readComplete[assignment.OriginalRequirement.ID] {
		t.Fatal("building an identity contract acknowledged unread input")
	}
	update := specialistChangeFixture(t, e, b, "edit", SuperSpecialistChange{Action: "update", RoleID: first.RoleID, ExpectedRevision: 1, Name: "新的名称", Duties: "只读核实，不改变已有任务"})
	if _, err = e.ManageSuperSpecialist(t.Context(), b, update); err != nil {
		t.Fatal(err)
	}
	second := superCreateFixture(t, e, b, "second", "核对 B", "b", "核对 B")
	a, err := e.BuildTaskAssignment(t.Context(), "pilot", first.TaskID)
	if err != nil || a != assignment {
		t.Fatal("old frozen assignment changed", a, err)
	}
	z, err := e.BuildTaskAssignment(t.Context(), "pilot", second.TaskID)
	if err != nil || z.RoleID != a.RoleID || z.RoleRevision != 2 || z.WorkerID == a.WorkerID || z.SessionID == a.SessionID || z.OriginRootTurnID == a.OriginRootTurnID {
		t.Fatal("new task reused execution history or old duties", z, err)
	}
	old, err := e.BuildTaskDigest(t.Context(), "pilot", first.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow(first.SessionID, first.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	goal.Status, goal.Summary = "completed", strings.Repeat("声称已完成<&>\"中文", 400)
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	digest, err := e.BuildTaskDigest(t.Context(), "pilot", first.TaskID)
	if err != nil || digest.State != "blocked" || digest.AcceptanceState == "pass" || !digest.Truncated || !utf8.ValidString(digest.Summary) || len(js(digest)) > TaskDigestBytes {
		t.Fatal("summary manufactured acceptance or exceeded budget", digest, err)
	}
	ref := old.Refs[0]
	if _, err = e.ReadSuperObjectChecked(t.Context(), "pilot", "task", ref.ID, ref.Revision, 0, 200, ref.Hash); err == nil {
		t.Fatal("stale canonical revision accepted")
	}
	if err = e.ConfigureTaskWorker(t.Context(), b.ProjectID, first.WorkerID, c); err != nil {
		t.Fatal(err)
	}
	if _, err = e.BuildTaskDigest(t.Context(), first.SessionID, second.TaskID); err == nil {
		t.Fatal("Worker read another task via a digest")
	}
	if _, err = e.ReadSuperObject(t.Context(), first.SessionID, "task_digest", second.TaskID, 0, 0, 100); err == nil {
		t.Fatal("Worker paged another task via a digest")
	}
}

func TestRouterContextContainsBoundedPrioritizedDigests(t *testing.T) {
	e, b := superFixture(t)
	first := superCreateFixture(t, e, b, "needs-answer", "PRIVATE_ORIGINAL: 核对 A，不得重启", "a", "核对 A")
	for i := 0; i < 12; i++ {
		superCreateFixture(t, e, b, uid(), "PRIVATE_ORIGINAL: 核对 B", uid(), "核对 B")
	}
	row, goal, err := e.workRow(first.SessionID, first.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	goal.Status = "waiting_user"
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	configureContextRouter(t, e, b)
	raw, err := e.BuildRouterContext(t.Context(), "pilot", nil)
	if err != nil || len(raw) > RouterContextBytes || strings.Contains(raw, "PRIVATE_ORIGINAL") {
		t.Fatal("default context copied original requirements", err)
	}
	var envelope struct {
		Tasks []SuperObjectPage `json:"tasks"`
		More  bool              `json:"tasksMore"`
	}
	if json.Unmarshal([]byte(raw), &envelope) != nil || len(envelope.Tasks) == 0 || len(envelope.Tasks) > RouterTaskDigests || !envelope.More || envelope.Tasks[0].ID != first.TaskID {
		t.Fatal("missing bounded priority/index", envelope)
	}
	for _, page := range envelope.Tasks {
		digest, err := DecodeTaskDigestV1(page.Text)
		if err != nil || page.Kind != "task_digest" || page.Hash != hash(page.Text) {
			t.Fatal(page, err)
		}
		ref := digest.Refs[0]
		if _, err = e.ReadSuperObjectChecked(t.Context(), "pilot", ref.Kind, ref.ID, ref.Revision, 0, 100, ref.Hash); err != nil {
			t.Fatal("digest lost its exact original", err)
		}
	}
}

func TestTaskDigestKeepsExactObjectCredentialBoundary(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "source", "只读检查", "check", "只读检查")
	configureContextRouter(t, e, b)
	secret := "synthetic-credential-" + strings.Repeat("x", 80)
	e.superSecrets.Store(secret, true)
	row, goal, err := e.workRow(task.SessionID, task.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	goal.Summary = strings.Repeat("a", 480) + secret
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	if digest, err := e.BuildTaskDigest(t.Context(), "pilot", task.TaskID); err == nil || digest.TaskID != "" {
		t.Fatal("digest bypassed the original credential boundary")
	}
	if _, err = e.ReadSuperObject(t.Context(), "pilot", "task_digest", task.TaskID, 0, 0, 100); err == nil {
		t.Fatal("digest page bypassed the original credential boundary")
	}
	if _, err = e.BuildRouterContext(t.Context(), "pilot", nil); err == nil {
		t.Fatal("default Router index bypassed the original credential boundary")
	}
}
