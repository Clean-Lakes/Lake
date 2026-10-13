package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestProjectMemoryAutomaticExtractionAndPerTurnIgnore(t *testing.T) {
	b, h := fixture(t)
	first, ref := newSession(t, h)
	project := stringOf(b.Store.Session(first)["projectId"])
	second := stringOf(apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "Second"}, 201)["id"])
	var mu sync.Mutex
	mainRequests := []string{}
	memoryTools := []bool{}
	extractions := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request["tools"] == nil {
			mu.Lock()
			extractions++
			mu.Unlock()
			emitModel(w, `{"schemaVersion":1,"mutations":[{"operation":"upsert","key":"backup-before-release","type":"project","description":"发布前先备份","body":"本项目发布前先备份。","sourceIds":["user:0"],"verification":"user-stated","expectedRevision":0}]}`, nil)
			return
		}
		mu.Lock()
		mainRequests = append(mainRequests, jsonText(request["messages"]))
		memoryTools = append(memoryTools, strings.Contains(jsonText(request["tools"]), "read_project_memory"))
		mu.Unlock()
		emitModel(w, "已收到发布要求。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "memory fixture", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+first+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+first+"/messages", Object{"text": "以后发布前先备份，作为项目规定。"}, 202)
	waitAI(t, b, first, "completed")
	b.workers.Wait()
	b.processOneMemoryJob()
	if got := stringOf(b.Store.ReadProjectMemory(project, "backup-before-release", false)["body"]); got != "本项目发布前先备份。" {
		t.Fatalf("automatic memory missing: %q", got)
	}
	apiTest(t, h, "POST", "/api/sessions/"+second+"/messages", Object{"text": "请说明发布流程中的注意事项。"}, 202)
	waitAI(t, b, second, "completed")
	b.workers.Wait()
	apiTest(t, h, "POST", "/api/sessions/"+second+"/messages", Object{"text": "本轮不要使用项目记忆。请只回答收到。", "ignoreProjectMemory": true}, 202)
	waitAI(t, b, second, "completed")
	b.workers.Wait()
	apiTest(t, h, "PATCH", "/api/projects/"+project+"/memory-settings", Object{"useEnabled": false, "extractionEnabled": false, "expectedRevision": 0}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+second+"/messages", Object{"text": "请核对这个项目下一步的发布要求。"}, 202)
	waitAI(t, b, second, "completed")
	b.workers.Wait()
	mu.Lock()
	requests := append([]string(nil), mainRequests...)
	tools := append([]bool(nil), memoryTools...)
	count := extractions
	mu.Unlock()
	if count != 1 {
		t.Fatalf("unexpected extraction count: %d", count)
	}
	if len(requests) != 4 || !strings.Contains(requests[1], "backup-before-release") || strings.Contains(requests[2], "PROJECT_MEMORY_INDEX") || strings.Contains(requests[3], "PROJECT_MEMORY_INDEX") || !tools[1] || tools[2] || tools[3] {
		t.Fatalf("index/ignore behavior: %d requests", len(requests))
	}
}

func TestProjectMemoryExplicitToolSaveAndForget(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var mu sync.Mutex
	stage := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		mu.Lock()
		stage++
		current := stage
		mu.Unlock()
		switch current {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "remember", Name: "save_project_memory", Arguments: jsonText(Object{"key": "release-rule", "type": "project", "description": "发布规则", "body": "本项目发布前先备份。", "expectedRevision": 0})}})
		case 3:
			emitModel(w, "", []ai.Call{{ID: "forget", Name: "forget_project_memory", Arguments: jsonText(Object{"key": "release-rule", "expectedRevision": 1})}})
		default:
			emitModel(w, "已处理项目记忆。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "memory tool fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请记住：本项目发布前先备份。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	if got := stringOf(b.Store.ReadProjectMemory(project, "release-rule", false)["body"]); got != "本项目发布前先备份。" {
		t.Fatalf("tool did not save: %q", got)
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请忘记 release-rule 这条项目记忆。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	if stringOf(b.Store.ReadProjectMemory(project, "release-rule", true)["deletedAt"]) == "" {
		t.Fatal("tool did not forget")
	}
}

func TestProjectMemoryToolRejectsUnrequestedWrite(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	stage := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stage++
		if stage == 1 {
			emitModel(w, "", []ai.Call{{ID: "unrequested", Name: "save_project_memory", Arguments: jsonText(Object{"key": "invented-rule", "type": "project", "description": "未经请求", "body": "任意内容", "expectedRevision": 0})}})
		} else {
			emitModel(w, "没有更改项目记忆。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "memory guard fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请查看今天服务状态。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	apiTest(t, h, "GET", "/api/projects/"+project+"/memory/invented-rule", nil, 404)
}
