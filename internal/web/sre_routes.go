package web

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) sreRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "projects" && parts[3] == "sre" {
		id := parts[2]
		b.Store.Project(id)
		switch method {
		case "GET":
			reply(w, 200, Object{"enabled": b.Store.SREEnabled(id)})
		case "PUT":
			data := body(w, r, 1024)
			enabled, ok := data["enabled"].(bool)
			if !ok || len(data) != 1 {
				fail(400, "仅支持 enabled 布尔字段")
			}
			b.Store.SetSREEnabled(id, enabled)
			reply(w, 200, Object{"enabled": enabled})
		default:
			fail(405, "Method not allowed")
		}
		return true
	}
	if len(parts) < 5 || parts[0] != "api" || parts[1] != "sessions" || parts[3] != "sre" || parts[4] != "tasks" {
		return false
	}
	sid := parts[2]
	session := b.Store.Session(sid)
	project := stringOf(session["projectId"])
	if len(parts) == 5 {
		switch method {
		case "GET":
			limit := 20
			if raw := r.URL.Query().Get("limit"); raw != "" {
				n, e := strconv.Atoi(raw)
				if e != nil || n < 1 || n > 50 {
					fail(400, "limit 须为 1–50")
				}
				limit = n
			}
			tasks, err := b.Store.ListSRETasks(sid, limit, r.URL.Query().Get("cursor"))
			sreFailure(err)
			cursor := ""
			if len(tasks) == limit {
				cursor = tasks[len(tasks)-1].ID
			}
			reply(w, 200, Object{"items": tasks, "nextCursor": cursor})
		case "POST":
			if !b.Store.SREEnabled(project) {
				fail(409, "请先启用本项目的 SRE 协作")
			}
			data := body(w, r, 16384)
			if old, err := b.Store.SRETaskByRequest(sid, stringOf(data["clientRequestId"])); err == nil && old != nil {
				reply(w, 202, old)
				return true
			}
			for k := range data {
				if !set("goal resourceIds mode clientRequestId")[k] {
					fail(400, "不支持的任务字段")
				}
			}
			scope := stringsOf(data["resourceIds"])
			task := b.createSRETask(sid, text(data["goal"], "goal", 4000), defaultText(data["mode"], "assist"), stringOf(data["clientRequestId"]), scope)
			if task.LatestPlan() == nil {
				b.launchSRE(sid, task.ID, task.Mode == "plan_only", task.Goal)
			}
			reply(w, 202, task)
		default:
			fail(405, "Method not allowed")
		}
		return true
	}
	if len(parts) == 6 && parts[5] == "from-workflow" && method == "POST" {
		if !b.Store.SREEnabled(project) {
			fail(409, "本项目未启用 SRE 协作")
		}
		data := body(w, r, 4096)
		workflow := b.Store.Workflow(project, text(data["workflowId"], "workflowId", 100))
		if workflow.Version != integer(data["version"]) {
			fail(409, "工作流版本已变化")
		}
		refs := []string{}
		seen := map[string]bool{}
		steps := []ai.SREPlanStep{}
		previous := ""
		for _, s := range workflow.Steps {
			for _, id := range s.ResourceIDs {
				if !seen[id] {
					seen[id] = true
					refs = append(refs, id)
				}
			}
			deps := []string{}
			if previous != "" {
				deps = append(deps, previous)
			}
			steps = append(steps, ai.SREPlanStep{ID: s.ID, Role: ai.SREInvestigator, Kind: "observe", Capability: s.Role, Description: s.Task, ResourceIDs: s.ResourceIDs, DependsOn: deps, CompletionChecks: []string{"取得可追溯的实际观察证据"}})
			previous = s.ID
		}
		task := b.createSRETask(sid, workflow.Goal, "plan_only", text(data["clientRequestId"], "clientRequestId", 100), refs)
		plan := ai.SREPlanRevision{Goal: workflow.Goal, TaskType: "investigation", Scope: refs, Steps: steps, Acceptance: []ai.SRECheck{}, ChangeReason: "从已保存只读工作流导入；没有继承操作授权"}
		updated, err := b.Engine.ReviseSREPlan(sid, task.ID, 0, plan)
		sreFailure(err)
		reply(w, 201, updated)
		return true
	}
	tid := parts[5]
	task, err := b.Store.LoadSRETask(sid, tid)
	sreFailure(err)
	if len(parts) == 6 {
		if method != "GET" {
			fail(405, "Method not allowed")
		}
		reply(w, 200, task)
		return true
	}
	op := parts[6]
	if len(parts) == 8 && op == "evidence" && method == "GET" {
		for _, attempt := range task.Attempts {
			for _, ev := range attempt.Evidence {
				if ev.ID == parts[7] {
					b.Store.AssertResource(sid, ev.ResourceID)
				}
			}
		}
		offset, parseErr := strconv.Atoi(defaultText(r.URL.Query().Get("offset"), "0"))
		if parseErr != nil {
			fail(400, "无效的证据偏移")
		}
		limit := 2048
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, _ = strconv.Atoi(raw)
		}
		value, err := b.Engine.SREEvidence(sid, tid, parts[7], offset, limit)
		sreFailure(err)
		reply(w, 200, value)
		return true
	}
	if len(parts) != 7 {
		fail(404, "SRE route not found")
	}
	if op == "events" && method == "GET" {
		after, e := strconv.ParseInt(defaultText(r.URL.Query().Get("after"), "0"), 10, 64)
		if e != nil || after < 0 || after > 9007199254740991 {
			fail(400, "无效事件游标")
		}
		events, err := b.Store.SREEvents(sid, tid, after, 100)
		sreFailure(err)
		reply(w, 200, Object{"items": events})
		return true
	}
	if op == "export" && method == "GET" {
		reply(w, 200, Object{"name": "运行手册草稿", "content": b.sreExport(task)})
		return true
	}
	if method != "POST" {
		fail(405, "Method not allowed")
	}
	data := body(w, r, 128<<10)
	switch op {
	case "plans":
		var plan ai.SREPlanRevision
		raw := jsonText(data["plan"])
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		if dec.Decode(&plan) != nil {
			fail(400, "计划字段或类型无效")
		}
		if b.Terminals.containsCredential(raw) {
			fail(400, "计划不能包含凭据")
		}
		b.configure(sid, nil)
		for _, rid := range plan.Scope {
			b.Store.AssertResource(sid, rid)
		}
		updated, err := b.Engine.ReviseSREPlan(sid, tid, integer(data["expectedVersion"]), plan)
		sreFailure(err)
		reply(w, 200, updated)
	case "start":
		if !b.Store.SREEnabled(project) {
			fail(409, "本项目的 SRE 协作已停用")
		}
		requestID := stringOf(data["clientRequestId"])
		if !workflowIdentifier.MatchString(requestID) {
			fail(400, "请提供 clientRequestId")
		}
		if task.Requests["start:"+requestID] != "" {
			reply(w, 202, task)
			return true
		}
		p := task.LatestPlan()
		if p == nil || p.Version != integer(data["planVersion"]) {
			fail(409, "计划版本已变化")
		}
		b.configure(sid, nil)
		_, err = b.Store.MutateSRETask(sid, tid, 0, "start_requested", func(t *ai.SRETask) error {
			if t.Requests == nil {
				t.Requests = map[string]string{}
			}
			t.Requests["start:"+requestID] = "accepted"
			return nil
		})
		sreFailure(err)
		b.launchSRE(sid, tid, false, "")
		reply(w, 202, task)
	case "control":
		requestID := stringOf(data["clientRequestId"])
		if !workflowIdentifier.MatchString(requestID) || integer(data["expectedRevision"]) < 1 {
			fail(400, "控制任务需有 clientRequestId 和 expectedRevision")
		}
		if task.Requests["control:"+requestID] != "" {
			reply(w, 200, task)
			return true
		}
		action := stringOf(data["action"])
		if !set("pause resume cancel")[action] {
			fail(400, "无效控制动作")
		}
		if action == "resume" {
			if !b.Store.SREEnabled(project) {
				fail(409, "请先开启本项目的 SRE 协作再继续任务")
			}
			b.configure(sid, nil)
			_, err = b.Store.MutateSRETask(sid, tid, integer(data["expectedRevision"]), "resume_requested", func(t *ai.SRETask) error {
				if t.Requests == nil {
					t.Requests = map[string]string{}
				}
				t.Requests["control:"+requestID] = action
				return nil
			})
			sreFailure(err)
			b.launchSRE(sid, tid, false, "")
			reply(w, 202, task)
			return true
		}
		updated, err := b.Store.MutateSRETask(sid, tid, integer(data["expectedRevision"]), "control_"+action, func(t *ai.SRETask) error {
			if t.Requests == nil {
				t.Requests = map[string]string{}
			}
			t.Requests["control:"+requestID] = action
			if !ai.SRETaskActive(t.Status) {
				return nil
			}
			next := "paused"
			if action == "cancel" {
				next = "cancelled"
			}
			return ai.TransitionSRETask(t, next)
		})
		sreFailure(err)
		sreFailure(b.Engine.ControlSRETask(sid, tid, action))
		reply(w, 200, updated)
	case "resolve":
		b.messageMu.Lock()
		busy := b.runningMessages[sid]
		b.messageMu.Unlock()
		if busy {
			fail(409, "请等待当前运行停止后核实操作")
		}
		updated, err := b.sreResolveOperation(sid, tid, integer(data["expectedRevision"]), text(data["operationId"], "operationId", 100), stringOf(data["result"]), text(data["note"], "note", 2000))
		sreFailure(err)
		reply(w, 200, updated)
	case "attest":
		passed, ok := data["passed"].(bool)
		if !ok {
			fail(400, "passed 须为布尔值")
		}
		updated, err := b.sreManualAttestation(sid, tid, stringOf(data["checkId"]), passed)
		sreFailure(err)
		b.syncSRESessionStatus(sid)
		reply(w, 200, updated)
	default:
		fail(404, "SRE operation not found")
	}
	return true
}
