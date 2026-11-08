package ai

import (
	"context"
	"errors"
	"strings"
	"testing"

	"gorm.io/gorm"
)

func specialistChangeFixture(t *testing.T, e *Engine, b SuperSourceBinding, id string, in SuperSpecialistChange) SuperSpecialistChange {
	t.Helper()
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: id, Kind: "message", Payload: "请管理专员：" + id})
	if err != nil {
		t.Fatal(err)
	}
	in.EventID, in.PartKey, in.Quote = event.ID, "profile", event.Payload
	return in
}

func TestSuperSpecialistsPrecreateEditReuseAndRestart(t *testing.T) {
	e, b := superFixture(t)
	create := specialistChangeFixture(t, e, b, "建立专员，不派任务", SuperSpecialistChange{Action: "create", RoleKey: "ops", Name: "运维专员", Duties: "只读检查主机"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, create)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 || channels[0].RoleID != role.ID || channels[0].Duties != role.Duties {
		t.Fatal(channels, err)
	}
	db, _ := e.superStore()
	for _, model := range []any{&nativeWorkGoal{}, &superWorkerRow{}, &superAssignmentRow{}, &securityTaskRow{}, &nativeOperation{}} {
		var n int64
		if err := db.Model(model).Count(&n).Error; err != nil || n != 0 {
			t.Fatal("profile created execution state", model, n, err)
		}
	}
	route := func(id string) SuperRouteResult {
		t.Helper()
		event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: id, Kind: "message", Payload: id})
		if err != nil {
			t.Fatal(err)
		}
		task, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "task", Action: "create", RoleID: role.ID, Title: id, Quote: id, Reason: "actual new request"})
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	first := route("检查主机 A")
	edit := specialistChangeFixture(t, e, b, "改名并修改职责", SuperSpecialistChange{Action: "update", RoleID: role.ID, ExpectedRevision: 1, Name: "可靠性专员", Duties: "检查主机并给出证据"})
	updated, err := e.ManageSuperSpecialist(t.Context(), b, edit)
	if err != nil || updated.ID != role.ID || updated.Revision != 2 || updated.RoleKey != "ops" {
		t.Fatal(updated, err)
	}
	replay, err := e.ManageSuperSpecialist(t.Context(), b, create)
	if err != nil || replay.Revision != 1 {
		t.Fatal("replay overwrote newer role", replay, err)
	}
	second := route("检查主机 B")
	var a, z superWorkerRow
	if err := db.First(&a, "id = ?", first.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&z, "id = ?", second.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if a.RoleID != role.ID || z.RoleID != role.ID || a.ID == z.ID || a.TaskID == z.TaskID || a.SessionID == z.SessionID || a.OriginRootTurnID == z.OriginRootTurnID {
		t.Fatal("shared execution context", a, z)
	}
	if !strings.Contains(superWorkerRoleContext(a), role.Duties) || strings.Contains(superWorkerRoleContext(a), updated.Duties) || !strings.Contains(superWorkerRoleContext(z), updated.Duties) {
		t.Fatal("task role snapshot was not frozen")
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Shutdown()
	page, err := next.ListSuperSpecialists(t.Context(), b.ProjectID, "", 20)
	if err != nil || len(page.Items) != 1 || page.Items[0] != updated {
		t.Fatal(page, err)
	}
	persisted, err := next.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(persisted) != 1 || persisted[0].ID != channels[0].ID || persisted[0].SessionID != channels[0].SessionID || persisted[0].RoleName != updated.Name || persisted[0].RoleRevision != 2 {
		t.Fatal(persisted, err)
	}
}

func TestSuperSpecialistsBoundariesAndConflicts(t *testing.T) {
	e, b := superFixture(t)
	in := specialistChangeFixture(t, e, b, "建立", SuperSpecialistChange{Action: "create", RoleKey: "ops", Name: "运维", Duties: "只读"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, in)
	if err != nil {
		t.Fatal(err)
	}
	forged := in
	forged.Name = "重放改写"
	if _, err := e.ManageSuperSpecialist(t.Context(), b, forged); err == nil {
		t.Fatal("conflicting replay accepted")
	}
	update := specialistChangeFixture(t, e, b, "修改", SuperSpecialistChange{Action: "update", RoleID: role.ID, ExpectedRevision: 2, Name: "新名称"})
	if _, err := e.ManageSuperSpecialist(t.Context(), b, update); err == nil {
		t.Fatal("stale revision accepted")
	}
	update.ExpectedRevision = 1
	update.Quote = "伪造授权"
	if _, err := e.ManageSuperSpecialist(t.Context(), b, update); err == nil {
		t.Fatal("forged quote accepted")
	}
	foreign := b
	foreign.ProjectID = "foreign"
	foreign.SourceID = "foreign-source"
	if err := e.RegisterSuperSource(t.Context(), foreign); err != nil {
		t.Fatal(err)
	}
	change := specialistChangeFixture(t, e, foreign, "跨项目编辑", SuperSpecialistChange{Action: "update", RoleID: role.ID, ExpectedRevision: 1, Name: "偷改"})
	if _, err := e.ManageSuperSpecialist(t.Context(), foreign, change); err == nil {
		t.Fatal("cross-project edit accepted")
	}
	automatic := b
	automatic.SourceID = "automatic"
	automatic.Kind = "schedule"
	if _, err := e.ManageSuperSpecialist(t.Context(), automatic, in); err == nil {
		t.Fatal("automated source edited role")
	}
	page, err := e.ListSuperSpecialists(t.Context(), foreign.ProjectID, "", 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatal("foreign listing leaked", page, err)
	}
	var count int
	for cursor := ""; ; {
		page, err := e.ListSuperSpecialists(t.Context(), b.ProjectID, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		count += len(page.Items)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if count != 1 {
		t.Fatal(count)
	}
}

func TestSuperSpecialistRouterToolsUseOfficialADKWithoutWorkers(t *testing.T) {
	e, b := superFixture(t)
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "create-only", Kind: "message", Payload: "创建审查专员，职责是检查依赖，先不要派任务"})
	if err != nil {
		t.Fatal(err)
	}
	m, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "create", Name: "manage_specialist", Arguments: js(map[string]any{"event_id": event.ID, "part_key": "reviewer", "action": "create", "role_key": "reviewer", "name": "审查专员", "duties": "检查依赖", "quote": event.Payload})})
		}
		if n == 2 {
			return response("", Call{ID: "list", Name: "list_specialists", Arguments: `{}`})
		}
		if !strings.Contains(js(input["messages"]), "检查依赖") {
			t.Error("missing durable profile result")
		}
		return response("已创建审查专员，尚未派任务。")
	})
	defer closeModel()
	if err = e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	if err = e.RunPilotRouter(t.Context(), "pilot", b); err != nil {
		t.Fatal(err)
	}
	workers, err := e.SuperQueuedWorkers(t.Context(), b.ProjectID)
	if err != nil || len(workers) != 0 {
		t.Fatal(workers, err)
	}
	page, err := e.ListSuperSpecialists(t.Context(), b.ProjectID, "", 20)
	if err != nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
	s, _ := e.get("pilot")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.superRole = "worker"
	if _, err := e.invokeSuperRouter(t.Context(), s, c, Call{Name: "list_specialists", Arguments: `{}`}); err == nil {
		t.Fatal("Worker gained role management")
	}
}

func TestSuperSpecialistProjectionFailureDoesNotUndoCanonicalMutation(t *testing.T) {
	e, b := superFixture(t)
	e.SuperRolesChanged = func(context.Context, string) error { return errors.New("projection temporarily down") }
	in := specialistChangeFixture(t, e, b, "建立", SuperSpecialistChange{Action: "create", RoleKey: "ops", Name: "运维"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, in)
	if err != nil {
		t.Fatal(err)
	}
	e.SuperRolesChanged = nil
	replay, err := e.ManageSuperSpecialist(t.Context(), b, in)
	if err != nil || replay != role {
		t.Fatal(replay, err)
	}
}

func TestSuperSpecialistSchemaFourMigrationPreservesTask(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "old-task", "Check A", "a", "Check A")
	before, err := e.SuperTaskDetail(task.SessionID, task.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	if err := db.Migrator().DropTable(&superRoleMutationRow{}); err != nil {
		t.Fatal(err)
	}
	for _, field := range []struct {
		model any
		name  string
	}{{&superRoleRow{}, "Duties"}, {&superWorkerRow{}, "RoleSnapshot"}} {
		if err := db.Migrator().DropColumn(field.model, field.name); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&superSchemaRow{}).Where("id = 1").Update("version", 4).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := MigrateSuperagentStore(db); err != nil {
			t.Fatal(err)
		}
	}
	after, err := e.SuperTaskDetail(task.SessionID, task.TaskID)
	if err != nil || js(before) != js(after) {
		t.Fatal("migration changed task", err)
	}
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil || !strings.Contains(worker.RoleSnapshot, "investigator") {
		t.Fatal(worker, err)
	}
	var missing superRoleMutationRow
	if err := db.First(&missing).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("migration invented edit history", err)
	}
}

func TestSuperSpecialistsPaginationAndExactRoleBoundaries(t *testing.T) {
	e, b := superFixture(t)
	roles := []SpecialistRole{}
	for _, key := range []string{"ops-a", "ops-b", "ops-c"} {
		change := specialistChangeFixture(t, e, b, key, SuperSpecialistChange{Action: "create", RoleKey: key, Name: "同名专员", Duties: "按指定任务工作"})
		role, err := e.ManageSuperSpecialist(t.Context(), b, change)
		if err != nil {
			t.Fatal(err)
		}
		roles = append(roles, role)
	}
	seen := map[string]bool{}
	for cursor := ""; ; {
		page, err := e.ListSuperSpecialists(t.Context(), b.ProjectID, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, role := range page.Items {
			if seen[role.ID] {
				t.Fatal("duplicate page")
			}
			seen[role.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatal("same-name roles collapsed or pagination truncated", seen)
	}
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	event := channelEventFixture(t, e, b, channels[0], "wrong-role", "独立检查")
	other := roles[0].ID
	if other == channels[0].RoleID {
		other = roles[1].ID
	}
	in := SuperDecision{EventID: event.ID, PartKey: "check", Action: "create", RoleID: other, Title: event.Payload, Quote: event.Payload, Reason: "must stay on source channel role"}
	if _, err := e.ApplySuperDecision(t.Context(), b, in); err == nil {
		t.Fatal("channel changed preferred role by ID")
	}
	foreign := b
	foreign.SourceID = "foreign-user"
	foreign.ProjectID = "foreign"
	if err := e.RegisterSuperSource(t.Context(), foreign); err != nil {
		t.Fatal(err)
	}
	f, _, err := e.ReceiveSuperEvent(t.Context(), foreign, SuperEventInput{SourceEventID: "foreign", Kind: "message", Payload: "独立检查"})
	if err != nil {
		t.Fatal(err)
	}
	in.EventID = f.ID
	if _, err := e.ApplySuperDecision(t.Context(), foreign, in); err == nil {
		t.Fatal("foreign role reused")
	}
}
