package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestBriefConversationUsesModelContextWithoutAutomaticInspection(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var calls atomic.Int32
	var contextSeen atomic.Bool
	b.Store.AddMessage(id, "assistant", "刚才讨论的目标是测试项目，请结合上下文回应。", nil)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		contextSeen.Store(strings.Contains(jsonText(body["messages"]), "刚才讨论的目标是测试项目"))
		emitModel(w, "模型根据上下文给出的回复。", nil)
	}))
	defer provider.Close()
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "local conversation fixture", "protocol": "openai"}))
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "silentCommands": true}, 200)
	for _, message := range []string{"好的", "谢谢", "你好", "收到"} {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": message}, 202)
		b.workers.Wait()
		view, err := b.Engine.Snapshot(id)
		if err != nil || view.Status != "completed" || view.Pending != nil || view.TurnFinishedAt == "" {
			t.Fatal("simple conversation did not finish", err)
		}
		for _, card := range view.Cards {
			if card.Type == "operation" || card.Type == "shell" {
				t.Fatal("acknowledgement triggered a tool")
			}
		}
		if len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
			t.Fatal("simple conversation created a terminal")
		}
	}
	if calls.Load() != 4 || !contextSeen.Load() {
		t.Fatal("brief conversation bypassed the model or discarded context")
	}
	last := objects(b.Store.Snapshot(id)["messages"])
	if len(last) == 0 || last[len(last)-1]["role"] != "assistant" || !strings.Contains(stringOf(last[len(last)-1]["text"]), "模型根据上下文给出的回复") {
		t.Fatal("completed reply missing from persisted messages")
	}
}

func TestForegroundPersistentCommandHonorsTimeout(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	start := time.Now()
	value, err := b.bridge(context.Background(), id, "runtimeCommandExec", Object{"asset_ref": ref, "runtime": "local", "command": "sleep 2", "timeout_ms": 80}, true)
	result := object(value)
	if err != nil || result["timed_out"] != true || result["status"] != "running" || time.Since(start) > time.Second {
		t.Fatal("foreground PTY ignored its bounded wait", err, result)
	}
	tid := stringOf(b.Store.Options(id)["terminal_id"])
	if b.Store.Terminal(id, tid)["status"] != "busy" {
		t.Fatal("wait timeout closed the persistent command")
	}
	if result["terminal_id"] != tid || stringOf(result["entry_id"]) == "" || result["exitCode"] != nil {
		t.Fatal("timeout lost command identity or invented an exit code", result)
	}
	b.Terminals.Close(id, tid)
}

func TestAcknowledgementCanContinueTheSpecificProposedTask(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	file := filepath.Join(t.TempDir(), "context.txt")
	must(os.WriteFile(file, []byte("approved-context-data"), 0600))
	b.Store.AddMessage(id, "assistant", "要读取测试说明文件来确认内容吗？", nil)
	var seen atomic.Bool
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		if step.Add(1) == 1 {
			if !strings.Contains(jsonText(body["messages"]), "要读取测试说明文件来确认内容吗") {
				t.Error("proposal context missing")
			}
			emitModel(w, "", []ai.Call{{ID: "accepted-read", Name: "read", Arguments: jsonText(Object{"path": file})}})
		} else {
			seen.Store(strings.Contains(jsonText(body["messages"]), "approved-context-data"))
			emitModel(w, "已根据你的确认读取测试说明。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "context acceptance fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "silentCommands": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "好的"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if !seen.Load() || step.Load() != 2 {
		t.Fatal("acknowledgement blocked context-approved task")
	}
}

func TestPersistentBackgroundOutputAvailableBeforeCompletion(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	var partialSeen atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		shellID := ""
		for _, m := range objects(body["messages"]) {
			if m["role"] != "tool" {
				continue
			}
			var result Object
			json.Unmarshal([]byte(stringOf(m["content"])), &result)
			if m["tool_call_id"] == "start-partial" {
				shellID = stringOf(result["shell_id"])
			}
			if m["tool_call_id"] == "read-partial" {
				entry := object(result["result"])
				output := stringOf(entry["output"])
				partialSeen.Store(result["status"] == "running" && entry["partial"] == true && strings.Contains(output, "PARTIAL_START") && !strings.Contains(output, "PARTIAL_END"))
				emitModel(w, "后台检查已开始", nil)
				return
			}
		}
		if shellID != "" {
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				tid := stringOf(b.Store.Options(id)["terminal_id"])
				if tid != "" && strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "PARTIAL_START\r") {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			emitModel(w, "", []ai.Call{{ID: "read-partial", Name: "shell_output", Arguments: jsonText(Object{"shell_id": shellID})}})
			return
		}
		emitModel(w, "", []ai.Call{{ID: "start-partial", Name: "shell", Arguments: jsonText(Object{"command": "printf 'PARTIAL_START\\n'; sleep 2; printf 'PARTIAL_END\\n'", "run_in_background": true, "timeout_ms": 5000})}})
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "partial output fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "silentCommands": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "启动隔离测试并查看中间输出"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if !partialSeen.Load() {
		t.Fatal("real PTY partial output was unavailable")
	}
	// Ensure the owner-scoped lookup cannot read another conversation's terminal.
	tid := stringOf(b.Store.Options(id)["terminal_id"])
	other := b.Store.CreateSession(stringOf(b.Store.Session(id)["projectId"]), "other fixture", nil)
	if _, err := b.bridge(context.Background(), stringOf(other["id"]), "terminal_command_status", Object{"terminal_id": tid, "entry_id": "unknown"}, false); err == nil {
		t.Fatal("partial output escaped conversation ownership")
	}
}

func TestCompactionFailureIsNotDuplicatedAsSystemMessage(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		json.NewDecoder(r.Body).Decode(&request)
		messages := objects(request["messages"])
		if len(messages) > 0 && strings.Contains(stringOf(messages[0]["content"]), "handoff summary") {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Object{"choices": []Object{{"message": Object{"content": "incomplete summary"}, "finish_reason": "length"}}})
		} else {
			emitModel(w, "你好", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "compaction fixture", Protocol: "openai"})
	for i := 0; i < 2; i++ {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
		waitAI(t, b, id, "completed")
		b.workers.Wait()
	}
	// Grow a compressible previous turn while keeping the current prompt and
	// tool catalog inside the configured window. A 2K window cannot fit the
	// runtime prompt and tests admission failure rather than summary failure.
	history, err := b.Engine.History(id)
	if err != nil {
		t.Fatal(err)
	}
	history[1].Content += strings.Repeat("old note ", 9000)
	if err := b.Engine.Restore(id, history); err != nil {
		t.Fatal(err)
	}
	b.configure(id, Object{"contextWindow": 64000, "maxOutput": 8192})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	waitAI(t, b, id, "failed")
	b.workers.Wait()
	view, err := b.Engine.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, card := range view.Cards {
		if card.Type == "error" && strings.Contains(card.Content, "context compaction:") {
			count++
		}
	}
	if count != 1 {
		t.Fatal("fatal error card missing or duplicated")
	}
	for _, message := range objects(b.Store.Snapshot(id)["messages"]) {
		if message["role"] == "system" && strings.Contains(stringOf(message["text"]), "context compaction:") {
			t.Fatal("engine error duplicated as native system message")
		}
	}
}
