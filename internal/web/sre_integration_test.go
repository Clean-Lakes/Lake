package web

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// A full-agent run can make dozens of sequential model calls. Race-enabled CI
// runners are about twice as slow as a local run, so the deadline leaves room
// for the longest fixture instead of assuming local speed.
const sreSettleTimeout = 45 * time.Second

func waitSRE(t *testing.T, b *Server, session, id string, statuses ...string) ai.SRETask {
	t.Helper()
	start := time.Now()
	deadline := start.Add(sreSettleTimeout)
	for time.Now().Before(deadline) {
		task, err := b.Store.LoadSRETask(session, id)
		if err != nil {
			t.Fatal(err)
		}
		for _, status := range statuses {
			if task.Status == status {
				return task
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	task, _ := b.Store.LoadSRETask(session, id)
	t.Fatalf("SRE did not settle after %s: status=%s error=%s messages=%v", time.Since(start).Round(time.Millisecond), task.Status, task.Error, task.Messages)
	return task
}
func configureSREModel(t *testing.T, b *Server, h *httptest.Server, session, resource string, plan ai.SREPlanRevision, logPath string) (*atomic.Int32, func()) {
	t.Helper()
	var writes atomic.Int32
	refPattern := regexp.MustCompile(`a_[a-f0-9]{16}`)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			reply(w, 200, Object{"data": []Object{{"id": "sre-fixture"}}})
			return
		}
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		content := jsonText(messages)
		system := ""
		if len(messages) > 0 {
			system = stringOf(messages[0]["content"])
		}
		if strings.Contains(system, "conversation owner") {
			emitSREReply(w, "answer", "这是对先前话题的追问，请说明你需要核对的具体内容。")
			return
		}
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		toolDone := false
		for _, m := range messages {
			toolDone = toolDone || m["role"] == "tool"
		}
		if strings.Contains(system, "Lake's investigator") && !toolDone {
			emitModel(w, "", []ai.Call{{ID: "observation", Name: "observe_logs", Arguments: jsonText(Object{"asset_ref": refPattern.FindString(content), "path": logPath})}})
			return
		}
		if strings.Contains(system, "Lake's executor") && !toolDone {
			writes.Add(1)
			var action *ai.SREAction
			for _, step := range plan.Steps {
				if step.Action != nil {
					action = step.Action
					break
				}
			}
			if action == nil {
				t.Error("no action")
			}
			emitModel(w, "", []ai.Call{{ID: "write_config", Name: action.Tool, Arguments: jsonText(action.Arguments)}})
			return
		}
		if strings.Contains(system, "Lake's executor") {
			emitModel(w, "写入已成功，业务已经恢复。", nil)
			return
		}
		if strings.Contains(system, "Lake's investigator") {
			ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "测试日志已采集", "facts": []Object{{"statement": "记录到连接等待日志", "evidenceIds": ids}}, "hypotheses": []string{}, "unknowns": []string{"根因待确认"}, "nextChecks": []string{}}), nil)
			return
		}
		emitModel(w, "已根据真实工具结果完成本阶段；仍需按任务验收条件核对。", nil)
	}))
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "sre-fixture", "protocol": "openai"}, 200)
	allowFixtureHost(b, session)
	project := stringOf(b.Store.Session(session)["projectId"])
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": true}, 200)
	return &writes, provider.Close
}

func TestSREReadOnlyConversationHasRealRolesEvidenceAndVersionHistory(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	logPath := filepath.Join(dir, "service.log")
	if err := os.WriteFile(logPath, []byte("SRE_LOG_EVIDENCE connection waiting\n"), 0600); err != nil {
		t.Fatal(err)
	}
	plan := ai.SREPlanRevision{Goal: "调查测试日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "logs", Role: ai.SREInvestigator, Kind: "observe", Capability: "application", Description: "读取测试日志", ResourceIDs: []string{resource}, CompletionChecks: []string{"记录实际日志"}}, {ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "归纳事实与缺口", ResourceIDs: []string{resource}, DependsOn: []string{"logs"}, CompletionChecks: []string{"不虚构根因"}}}}
	_, close := configureSREModel(t, b, h, session, resource, plan, logPath)
	defer close()
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": "调查测试日志", "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "readonly_1"}, 202)
	task := waitSRE(t, b, session, stringOf(created["id"]), "completed", "paused")
	if task.Status != "completed" {
		t.Fatal(task.Error)
	}
	if len(task.Plans) != 1 || len(task.Attempts) != 2 || len(task.Attempts[0].Evidence) == 0 {
		t.Fatal("missing actual roles/evidence")
	}
	for _, message := range task.Messages {
		if message.RoleID == ai.SREExecutor {
			t.Fatal("fabricated executor in readonly task")
		}
		if message.RoleRunID == "" {
			t.Fatal("message did not come from real role run")
		}
	}
	ev := task.Attempts[0].Evidence[0]
	page := apiTest(t, h, "GET", "/api/sessions/"+session+"/sre/tasks/"+task.ID+"/evidence/"+ev.ID, nil, 200)
	if !strings.Contains(stringOf(page["source"]), "SRE_LOG_EVIDENCE") {
		t.Fatal("source not readable")
	}
	other, _ := newSession(t, h)
	apiTest(t, h, "GET", "/api/sessions/"+other+"/sre/tasks/"+task.ID, nil, 404)
	snapshot := apiTest(t, h, "GET", "/api/sessions/"+session+"/snapshot", nil, 200)
	if len(objects(object(snapshot["sre"])["tasks"])) != 1 {
		t.Fatal("snapshot lost task")
	}
	if err := b.Engine.AnswerSRERole(context.Background(), session, task.ID, ai.SREVerifier, "解释这次验收的范围"); err != nil {
		t.Fatal(err)
	}
	answered, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || answered.Status != "completed" || len(answered.Attempts) != len(task.Attempts) || len(answered.Messages) != len(task.Messages)+1 || answered.Messages[len(answered.Messages)-1].RoleID != ai.SREVerifier {
		t.Fatal("role question reopened task or dispatched an operation", err)
	}

}

func TestSREPlanOnlyDoesNotDispatchAndApprovalRejectionHasNoEffect(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	target := filepath.Join(dir, "config.log")
	alias := sreAliasForTest(resource)
	action := &ai.SREAction{Tool: "write", Arguments: map[string]any{"asset_ref": alias, "path": target, "content": "SRE_TEST_CONFIG"}, Reason: "用户指定的测试写入", Impact: "仅测试文件", Rollback: "移除测试文件", StopCondition: "失败则停止"}
	plan := ai.SREPlanRevision{Goal: "写入测试配置", TaskType: "change", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "write", Role: ai.SREExecutor, Kind: "act", Description: "写入测试文件", ResourceIDs: []string{resource}, CompletionChecks: []string{"文件已写入"}, Action: action}, {ID: "verify", Role: ai.SREVerifier, Kind: "verify", Description: "验证测试配置", ResourceIDs: []string{resource}, DependsOn: []string{"write"}, CompletionChecks: []string{"用户确认"}}}, Acceptance: []ai.SRECheck{{ID: "config", Description: "确认测试配置内容", Kind: "manual_attestation"}}}
	writes, close := configureSREModel(t, b, h, session, resource, plan, target)
	defer close()
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": "只出计划：写入测试配置", "resourceIds": []string{resource}, "mode": "plan_only", "clientRequestId": "plan_only_1"}, 202)
	id := stringOf(created["id"])
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		task, _ := b.Store.LoadSRETask(session, id)
		if len(task.Plans) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if writes.Load() != 0 {
		t.Fatal("plan-only executed write")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("effect before start")
	}
	// Wait for parent ownership to be released after the durable plan event.
	for {
		b.messageMu.Lock()
		busy := b.runningMessages[session]
		b.messageMu.Unlock()
		if !busy {
			break
		}
		time.Sleep(time.Millisecond)
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks/"+id+"/start", Object{"planVersion": 1, "clientRequestId": "start_1"}, 202)
	var pending ai.AgentRun
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		view, _ := b.Engine.Snapshot(session)
		for _, run := range view.AgentRuns {
			if run.SRERole == ai.SREExecutor && run.Pending != nil {
				pending = run
			}
		}
		if pending.Pending != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if pending.Pending == nil {
		task, _ := b.Store.LoadSRETask(session, id)
		t.Fatalf("no approval: %s", task.Error)
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": false}, 200)
	task := waitSRE(t, b, session, id, "paused")
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("rejected write executed")
	}
	if len(task.Attempts) == 0 {
		t.Fatal("attempt lost")
	}
	last := task.Attempts[len(task.Attempts)-1]
	if len(last.Operations) != 1 || last.Operations[0].Status != "rejected" || !strings.Contains(last.Result, "已拒绝，未执行") {
		t.Fatal("model prose overwrote actual rejected dispatch", last.Result)
	}
	for _, m := range task.Messages {
		if m.RoleID == ai.SREExecutor && !strings.Contains(m.Body, "已拒绝，未执行") {
			t.Fatal("executor message did not reflect recorded rejection", m.Body)
		}
	}

}

func sreAliasForTest(resource string) string {
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte(resource)))
	return "a_" + sum[:16]
}

func TestSREApprovedChangeRequiresFreshIndependentVerification(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	target := filepath.Join(dir, "sre-config.log")
	alias := sreAliasForTest(resource)
	action := &ai.SREAction{Tool: "write", Arguments: map[string]any{"asset_ref": alias, "path": target, "content": "SRE_APPROVED_CONFIG"}, Reason: "测试写入", Impact: "仅测试配置", Rollback: "移除测试配置", StopCondition: "验证失败则停止"}
	plan := ai.SREPlanRevision{Goal: "写入测试配置并核对主机磁盘余量", TaskType: "change", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "write", Role: ai.SREExecutor, Kind: "act", Description: "写入隔离配置", ResourceIDs: []string{resource}, CompletionChecks: []string{"实际写入"}, Action: action}, {ID: "verify", Role: ai.SREVerifier, Kind: "verify", Description: "独立采样磁盘可用空间", ResourceIDs: []string{resource}, DependsOn: []string{"write"}, CompletionChecks: []string{"可用比例大于等于零"}}}, Acceptance: []ai.SRECheck{{ID: "disk", Description: "测试主机磁盘可用比例大于等于零", Kind: "number_threshold", ResourceID: resource, Probe: &ai.SREAction{Tool: "observe_host", Arguments: map[string]any{"asset_ref": alias, "metric": "overview"}}, Path: "disks.0.available_percent_of_total", Operator: "gte", Expected: 0.0, MinSamples: 1}}}
	writes, close := configureSREModel(t, b, h, session, resource, plan, target)
	defer close()
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "approved_1"}, 202)
	id := stringOf(created["id"])
	var pending ai.AgentRun
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		view, _ := b.Engine.Snapshot(session)
		for _, r := range view.AgentRuns {
			if r.SRERole == ai.SREExecutor && r.Pending != nil {
				pending = r
			}
		}
		if pending.Pending != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if pending.Pending == nil {
		task, _ := b.Store.LoadSRETask(session, id)
		t.Fatal("approval missing", task.Error)
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true}, 200)
	task := waitSRE(t, b, session, id, "completed", "paused")
	if task.Status != "completed" {
		t.Fatal("verification did not pass", task.Error)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "SRE_APPROVED_CONFIG" {
		t.Fatal("actual write missing", err)
	}
	if writes.Load() != 1 || task.RecoveryStatus != "verified" || len(task.Verifications) != 1 || task.Verifications[0].Verdict != "passed" {
		t.Fatal("wrong recovery state")
	}
	op := task.Attempts[0].Operations[0]
	ev := task.Attempts[1].Evidence[0]
	if op.Status != "succeeded" || ev.CollectedAt <= op.FinishedAt {
		t.Fatal("verification reused old evidence")
	}
	if task.Attempts[0].RoleRunID == task.Attempts[1].RoleRunID {
		t.Fatal("executor and verifier shared context")
	}
}
