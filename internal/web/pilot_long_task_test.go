package web

import (
	"context"
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

// Exercise more than a hundred real dispatches across parallel specialists,
// including a failed read, replacement, zero-match query and pause/resume.
func TestPilotLongTaskCompletesAcrossParallelRolesAndResume(t *testing.T) {
	for _, pause := range []bool{false, true} {
		t.Run(fmt.Sprintf("pause_%t", pause), func(t *testing.T) {
			b, h := fixture(t)
			session, resource := newSession(t, h)
			dir, _ := filepath.EvalSymlinks(t.TempDir())
			const samples = 20
			for group := 0; group < 3; group++ {
				for n := 0; n < samples; n++ {
					must(os.WriteFile(filepath.Join(dir, fmt.Sprintf("g%d_%02d.log", group, n)), []byte(fmt.Sprintf("LONG_REAL_SOURCE group=%d item=%d\n", group, n)), 0600))
				}
			}
			plan := ai.SREPlanRevision{Goal: "长任务逐项真实取证并独立复核", TaskType: "investigation", Scope: []string{resource}}
			for phase := 0; phase < 2; phase++ {
				for group := 0; group < 3; group++ {
					id := fmt.Sprintf("p%dg%d", phase, group)
					role := []ai.SREAgentRole{ai.SRECoordinator, ai.SREInvestigator, ai.SREVerifier}[group]
					kind := []string{"analyze", "observe", "verify"}[group]
					deps := []string{}
					if phase == 1 {
						deps = []string{fmt.Sprintf("p0g%d", group)}
					}
					plan.Steps = append(plan.Steps, ai.SREPlanStep{ID: id, AssignmentID: id, Role: role, Kind: kind, Capability: "application", Description: "LONG_STEP=" + id, ResourceIDs: []string{resource}, DependsOn: deps, CompletionChecks: []string{"逐项取得真实数据、保留来源且独立核对"}})
				}
			}
			plan.Steps = append(plan.Steps, ai.SREPlanStep{ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "LONG_FINAL", ResourceIDs: []string{resource}, DependsOn: []string{"p1g0", "p1g1", "p1g2"}, CompletionChecks: []string{"六个工作项完成后唯一汇总"}})
			var arrivals, requests atomic.Int32
			ready := make(chan struct{})
			pauseReached := make(chan struct{})
			var pauseTriggered atomic.Bool
			stepPattern := regexp.MustCompile(`Assigned deliverable: LONG_STEP=(p[01]g[012])`)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					reply(w, 200, Object{"data": []Object{{"id": "long-fixture"}}})
					return
				}
				var input Object
				_ = json.NewDecoder(r.Body).Decode(&input)
				content := jsonText(input["messages"])
				requests.Add(1)
				if strings.Contains(content, "Return only a JSON plan object") {
					emitModel(w, jsonText(plan), nil)
					return
				}
				select {
				case <-r.Context().Done():
					return
				case <-time.After(20 * time.Millisecond):
				}
				if strings.Contains(content, "Assigned deliverable: LONG_FINAL") {
					emitModel(w, "长任务完成：六个工作项均取得真实独立证据，未执行变更。", nil)
					return
				}
				match := stepPattern.FindStringSubmatch(content)
				if len(match) != 2 {
					t.Error("lost assigned long step")
					emitModel(w, "未找到工作项，检查失败。", nil)
					return
				}
				stepID := match[1]
				tasks, err := b.Store.ListSRETasks(session, 20, "")
				if err != nil || len(tasks) != 1 {
					t.Error("lost durable task", err)
					return
				}
				task := tasks[0]
				var attempt ai.SREStepAttempt
				for _, a := range task.Attempts {
					if a.StepID == stepID {
						attempt = a
					}
				}
				if pause && strings.HasPrefix(stepID, "p1") && len(attempt.Operations) >= 5 && !pauseTriggered.Swap(true) {
					close(pauseReached)
					<-r.Context().Done()
					return
				}
				if len(attempt.Operations) == 0 && strings.HasPrefix(stepID, "p0") {
					if arrivals.Add(1) == 3 {
						close(ready)
					}
					select {
					case <-ready:
					case <-r.Context().Done():
						return
					case <-time.After(8 * time.Second):
						t.Error("three specialists failed to progress concurrently")
						return
					}
				}
				call := func(id, name string, args Object) {
					emitModel(w, "", []ai.Call{{ID: stepID + "_" + id, Name: name, Arguments: jsonText(args)}})
				}
				group := int(stepID[3] - '0')
				byID := map[string]ai.SREOperation{}
				for _, op := range attempt.Operations {
					byID[op.Call.ID] = op
				}
				if stepID == "p0g0" {
					if _, ok := byID[stepID+"_missing"]; !ok {
						call("missing", "read", Object{"asset_ref": sreAliasForTest(resource), "path": filepath.Join(dir, "missing.log"), "runtime": "local"})
						return
					}
				}
				for n := 0; n < samples; n++ {
					id := fmt.Sprintf("sample_%02d", n)
					if _, ok := byID[stepID+"_"+id]; ok {
						continue
					}
					path := filepath.Join(dir, fmt.Sprintf("g%d_%02d.log", group, n))
					if n == samples-1 {
						call(id, "shell", Object{"asset_ref": sreAliasForTest(resource), "command": "grep -c 'UNMATCHED_QA_TOKEN' " + quote(path), "runtime": "local"})
					} else {
						call(id, "read", Object{"asset_ref": sreAliasForTest(resource), "path": path, "runtime": "local"})
					}
					return
				}
				if stepID == "p0g0" && len(attempt.ReadRecoveries) == 0 {
					failed := byID[stepID+"_missing"]
					replacement := byID[stepID+"_sample_00"]
					call("recovery", "pilot_read_recovery", Object{"failed_operation_id": failed.ID, "replacement_operation_ids": []string{replacement.ID}, "reason": "原路径不存在，已读取该工作项的实际日志"})
					return
				}
				ids := []string{}
				for _, ev := range attempt.Evidence {
					if ev.Success {
						ids = append(ids, ev.ID)
					}
				}
				if group == 1 {
					facts := []Object{{"statement": "前16份实际取证完成", "evidenceIds": ids[:min(16, len(ids))]}}
					if len(ids) > 16 {
						facts = append(facts, Object{"statement": "剩余实际取证及零匹配完成", "evidenceIds": ids[16:]})
					}
					emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已逐项核对20份真实样本", "facts": facts, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
				} else {
					emitModel(w, "独立复核20份实际样本完成，零匹配检查完整结束，未执行变更。", nil)
				}
			}))
			defer provider.Close()
			apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "long-fixture", "protocol": "openai"}, 200)
			allowFixtureHost(b, session)
			apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"contextWindow": 128000, "maxOutput": 8192, "maxSteps": 160}, 200)
			project := stringOf(b.Store.Session(session)["projectId"])
			apiTest(t, h, "PUT", "/api/projects/"+project+"/pilot", Object{"enabled": true, "autoAdvance": true, "expectedRevision": 0}, 200)
			created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "long_run"}, 202)
			id := stringOf(created["id"])
			defer b.Engine.ControlSRETask(session, id, "cancel")
			completedBefore := map[string]string{}
			if pause {
				select {
				case <-pauseReached:
				case <-time.After(45 * time.Second):
					t.Fatal("long task never reached partial verification")
				}
				before, _ := b.Store.LoadSRETask(session, id)
				for _, a := range before.Attempts {
					if strings.HasPrefix(a.StepID, "p0") && a.Status == "succeeded" {
						completedBefore[a.StepID] = a.ID
					}
				}
				if len(completedBefore) == 0 {
					t.Fatal("pause point lacked completed work")
				}

				if err := b.Engine.ControlSRETask(session, id, "pause"); err != nil {
					t.Fatal(err)
				}
				waitSRE(t, b, session, id, "paused")
				for deadline := time.Now().Add(5 * time.Second); ; {
					v, _ := b.Engine.Snapshot(session)
					if v.Status != "running" {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("paused main run did not finish cleanup")
					}
					time.Sleep(10 * time.Millisecond)
				}
				if err := b.Engine.ResumeSRETask(context.Background(), session, id); err != nil {
					t.Fatal("resume failed", err)
				}
			}
			// This deliberately dispatches >120 real operations; race instrumentation
			// costs much more than the short-role fixtures' 45 second settle window.
			deadline := time.Now().Add(150 * time.Second)
			var task ai.SRETask
			for {
				task, _ = b.Store.LoadSRETask(session, id)
				if task.Status == "completed" || task.Status == "paused" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("long task did not settle: status=%s attempts=%d", task.Status, len(task.Attempts))
				}
				time.Sleep(50 * time.Millisecond)
			}
			if task.Status != "completed" {
				for _, a := range task.Attempts {
					successful := 0
					for _, ev := range a.Evidence {
						if ev.Success {
							successful++
						}
					}
					t.Logf("step=%s status=%s ops=%d evidence=%d good=%d result=%s", a.StepID, a.Status, len(a.Operations), len(a.Evidence), successful, a.Result)
					if len(a.Operations) > 0 {
						t.Logf("first operation=%+v", a.Operations[0])
					}
				}
				t.Fatalf("long task failed: %s", task.Error)
			}
			ops, evidence, recoveries, finals := 0, 0, 0, 0
			evidenceIDs := map[string]bool{}
			for _, a := range task.Attempts {
				ops += len(a.Operations)
				evidence += len(a.Evidence)
				recoveries += len(a.ReadRecoveries)
				for _, ev := range a.Evidence {
					if evidenceIDs[ev.ID] {
						t.Error("duplicate evidence identity")
					}
					evidenceIDs[ev.ID] = true
				}
				if old, ok := completedBefore[a.StepID]; ok && old != a.ID {
					t.Error("completed work was rerun after pause", a.StepID)
				}
			}
			for _, m := range task.Messages {
				if m.Kind == "summary" {
					finals++
				}
			}
			if ops < 121 || evidence < 121 || recoveries < 1 || finals != 1 || arrivals.Load() != 3 {
				t.Fatalf("incomplete long run: ops=%d evidence=%d recoveries=%d finals=%d parallel=%d", ops, evidence, recoveries, finals, arrivals.Load())
			}
			t.Logf("long task passed: requests=%d operations=%d evidence=%d attempts=%d recoveries=%d final=%d", requests.Load(), ops, evidence, len(task.Attempts), recoveries, finals)
		})
	}
}
