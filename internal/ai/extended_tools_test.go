package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func invokeExtra(t *testing.T, e *Engine, name string, a map[string]any) (any, error) {
	t.Helper()
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	return e.invoke(context.Background(), s, c, Call{ID: uid(), Name: name, Arguments: js(a)})
}
func TestExtendedTodoPersistenceAndSchemas(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "tool fixture"}, nil)
	if _, err := invokeExtra(t, e, "todo_write", map[string]any{"todos": []any{map[string]any{"content": "检查日志", "status": "in_progress"}}}); err != nil {
		t.Fatal(err)
	}
	other, _ := New(e.Dir, nil, nil)
	defer other.Shutdown()
	v, _ := other.Snapshot("case")
	if len(v.Todos) != 1 || v.Todos[0].Content != "检查日志" {
		t.Fatal(v)
	}
	for _, a := range []map[string]any{{"todos": []any{map[string]any{"content": "x", "status": "invented"}}}, {"todos": []any{}, "extra": true}} {
		if _, err := invokeExtra(t, e, "todo_write", a); err == nil {
			t.Fatal("invalid todo accepted")
		}
	}
	for _, tool := range Catalog("core") {
		if tool.Name == "read_tool_result" {
			if validateTool(tool, map[string]any{"result_id": "x", "offset": 1.5}) == nil || validateTool(tool, map[string]any{"result_id": "x", "limit": 0}) == nil {
				t.Fatal("integer/range unchecked")
			}
		}
	}
}
func TestQuestionReplyCancellationAndRestart(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "tool fixture"}, nil)
	s, _ := e.get("case")
	call := Call{ID: uid(), Name: "ask_user_question", Arguments: js(map[string]any{"questions": []any{map[string]any{"id": "target", "title": "选择目标", "options": []any{"测试", "生产"}}}})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := e.askQuestion(ctx, s, call); done <- err }()
	var request *QuestionRequest
	for until := time.Now().Add(time.Second); time.Now().Before(until); {
		v, _ := e.Snapshot("case")
		if v.Question != nil {
			request = v.Question
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request == nil {
		t.Fatal("missing question")
	}
	if e.ReplyQuestion("case", request.ID, map[string][]string{"wrong": {"x"}}) == nil {
		t.Fatal("unknown answer key accepted")
	}
	restarted, _ := New(e.Dir, nil, nil)
	defer restarted.Shutdown()
	v, _ := restarted.Snapshot("case")
	if v.Question != nil {
		t.Fatal("restart retained stale question")
	}
	if err := e.ReplyQuestion("case", request.ID, map[string][]string{"target": {"测试"}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if e.ReplyQuestion("case", request.ID, nil) == nil {
		t.Fatal("duplicate reply accepted")
	}
	call.Arguments = strings.ReplaceAll(call.Arguments, "选择目标", "选择新的目标")
	go func() { _, err := e.askQuestion(ctx, s, call); done <- err }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	v, _ = e.Snapshot("case")
	if v.Question != nil {
		t.Fatal("cancel left question pending")
	}
}
func TestToolResultPagingRedactionAndIsolation(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "tool fixture"}, nil)
	s, _ := e.get("case")
	content := strings.Repeat("中文日志\n", 5000) + "\npassword=synthetic-password"
	envelope, err := e.persistToolResult(s, Config{}, Call{Name: "shell"}, content)
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	json.Unmarshal([]byte(envelope), &meta)
	recovered := ""
	offset := 0
	for {
		value, err := e.readToolResult("case", map[string]any{"result_id": meta["result_id"], "offset": offset, "limit": 1024})
		if err != nil {
			t.Fatal(err)
		}
		page := obj(value)
		recovered += str(page["content"])
		if page["complete"] == true {
			break
		}
		offset = num(page["next_offset"], 0)
	}
	if recovered != redact(content, Config{}) || strings.Contains(recovered, "synthetic-password") {
		t.Fatal("paging corrupted/redaction missing")
	}
	if _, err = e.readToolResult("other", map[string]any{"result_id": meta["result_id"]}); err == nil {
		t.Fatal("foreign result readable")
	}
}
func TestFilePagingSearchAndStaleRead(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "tool fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.Permissions = &Permissions{SilentReadFiles: true, SilentWriteFiles: true}
	s.state.Config = c
	path := filepath.Join(c.Workspace, "日志.txt")
	content := strings.Repeat("长行", 20000) + "\nsecond\nthird"
	os.WriteFile(path, []byte(content), 0600)
	offset, byteOffset := 0, 0
	recovered := ""
	for {
		value, err := e.file(context.Background(), s, c, "read", map[string]any{"path": path, "offset": offset, "byte_offset": byteOffset, "limit": 1})
		if err != nil {
			t.Fatal(err)
		}
		page := obj(value)
		recovered += str(page["content"])
		if page["truncated"] != true {
			break
		}
		offset = num(page["next_offset"], 0)
		byteOffset = num(page["next_byte_offset"], 0)
	}
	if recovered != content {
		t.Fatal("file paging corrupted")
	}
	os.WriteFile(path, []byte("changed"), 0600)
	if _, err := invokeExtra(t, e, "write", map[string]any{"path": path, "content": "overwrite"}); err == nil {
		t.Fatal("stale read overwritten")
	}
	os.WriteFile(filepath.Join(c.Workspace, "app.log"), []byte("before\nERROR problem\nafter\n"), 0600)
	result, err := e.searchFiles(context.Background(), c, "grep", map[string]any{"path": c.Workspace, "pattern": "error", "ignore_case": true, "glob": "*.log", "context": 1})
	if err != nil || len(obj(result)["lines"].([]string)) != 3 {
		t.Fatal(result, err)
	}
	result, err = e.searchFiles(context.Background(), c, "glob", map[string]any{"path": c.Workspace, "pattern": "**/*.log"})
	if err != nil || len(obj(result)["lines"].([]string)) != 1 {
		t.Fatal(result, err)
	}
}
func TestSkillPathIsolationAndImageObservation(t *testing.T) {
	t.Setenv("LAKE_HOME", t.TempDir())
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "vision fixture", SupportsImageInput: true}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	root := filepath.Join(c.Workspace, ".agents", "skills")
	os.MkdirAll(filepath.Join(root, "safe"), 0700)
	os.WriteFile(filepath.Join(root, "safe", "SKILL.md"), []byte("inspect bounded logs"), 0600)
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "SKILL.md"), []byte("outside"), 0600)
	os.Symlink(outside, filepath.Join(root, "escape"))
	if _, err := e.loadSkill(c, "safe"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../safe", "escape"} {
		if _, err := e.loadSkill(c, name); err == nil {
			t.Fatal("skill escaped")
		}
	}
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	path := filepath.Join(c.Workspace, "image.png")
	os.WriteFile(path, b.Bytes(), 0600)
	value, err := e.file(context.Background(), s, c, "read", map[string]any{"path": path})
	if err != nil {
		t.Fatal(err)
	}
	img := obj(value)["image"].(ImageAttachment)
	raw, _ := base64.StdEncoding.DecodeString(img.Base64)
	if !bytes.Equal(raw, b.Bytes()) {
		t.Fatal("image bytes changed")
	}
	c.Model.SupportsImageInput = false
	if _, err = e.file(context.Background(), s, c, "read", map[string]any{"path": path}); err == nil {
		t.Fatal("non-vision model accepted image")
	}
}

func TestImageToolBatchUsesExistingVisionProjection(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "vision fixture", SupportsImageInput: true}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	var data bytes.Buffer
	_ = png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	path := filepath.Join(c.Workspace, "read.png")
	_ = os.WriteFile(path, data.Bytes(), 0600)
	call := Call{ID: "read-image", Name: "read", Arguments: js(map[string]any{"path": path})}
	s.mu.Lock()
	s.state.History = append(s.state.History, Message{Role: "assistant", Calls: []Call{call}})
	s.mu.Unlock()
	if err := e.invokeCalls(context.Background(), s, &c, []Call{call}); err != nil {
		t.Fatal(err)
	}
	history, err := e.History("case")
	if err != nil || validHistory(history) != nil {
		t.Fatal(err)
	}
	last := history[len(history)-1]
	if last.Role != "user" || len(last.Images) != 1 {
		t.Fatal("image not projected to vision history")
	}
	for _, protocol := range []string{"openai", "openai-response", "claude", "gemini", "ollama"} {
		model := c.Model
		model.Protocol = protocol
		_, body, err := modelPayload(model, history, nil)
		if err != nil || !strings.Contains(js(body), last.Images[0].Base64) {
			t.Fatal(protocol, err)
		}
	}
}
func TestPDFAdapterAndUnifiedShellTasks(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "tool fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	adapterDir := t.TempDir()
	adapter := filepath.Join(adapterDir, "pdftotext")
	if err := os.WriteFile(adapter, []byte("#!/bin/sh\nprintf 'page-one\\npage-two\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", adapterDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	file := filepath.Join(c.Workspace, "fixture.pdf")
	_ = os.WriteFile(file, []byte("synthetic PDF adapter input"), 0600)
	value, err := e.file(context.Background(), s, c, "read", map[string]any{"path": file, "limit": 1, "pages": "1-2"})
	if err != nil || str(obj(value)["content"]) != "page-one\n" || obj(value)["truncated"] != true {
		t.Fatal(value, err)
	}
	if _, err = e.file(context.Background(), s, c, "read", map[string]any{"path": file, "pages": "1;echo bad"}); err == nil {
		t.Fatal("invalid PDF range accepted")
	}
	args := map[string]any{"__session": "case", "run_in_background": true}
	started, err := e.startShell(c, args, "printf unified-task")
	if err != nil {
		t.Fatal(err)
	}
	id := str(obj(started)["shell_id"])
	for until := time.Now().Add(time.Second); time.Now().Before(until); {
		result, err := e.taskTool(context.Background(), s, c, Call{Name: "task_output"}, map[string]any{"task_id": id, "type": "shell"})
		if err != nil {
			t.Fatal(err)
		}
		if obj(result)["status"] == "completed" {
			if !strings.Contains(js(result), "unified-task") {
				t.Fatal(result)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("unified task output did not complete")
}

func TestContextQuestionRichOptionsSkipAndReuse(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "question fixture"}, nil)
	s, _ := e.get("case")
	call := Call{ID: uid(), Name: "ask_user_question", Arguments: `{"questions":[{"id":"scope","title":"调查范围","reason":"不同范围会改变证据采集","multi_select":true,"options":[{"label":"架构与 API","description":"模块和接口清单","recommended":true},"核心日志"]}]}`}
	for _, tool := range Catalog("core") {
		if tool.Name == call.Name {
			a, _ := args(call)
			if err := validateTool(tool, a); err != nil {
				t.Fatal(err)
			}
			a["questions"] = []any{map[string]any{"id": "bad", "title": "bad", "options": []any{map[string]any{"label": "x", "unexpected": true}}}}
			if validateTool(tool, a) == nil {
				t.Fatal("unknown option fields accepted")
			}
		}
	}
	done := make(chan map[string]any, 1)
	go func() {
		value, err := e.askQuestion(context.Background(), s, call)
		if err != nil {
			done <- map[string]any{"error": err.Error()}
			return
		}
		done <- obj(value)
	}()
	var request *QuestionRequest
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		view, _ := e.Snapshot("case")
		if view.Question != nil {
			request = view.Question
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request == nil || request.Questions[0].Options[0].Description != "模块和接口清单" {
		t.Fatal("rich option missing")
	}
	if err := e.ReplyQuestion("case", request.ID, map[string][]string{}); err != nil {
		t.Fatal(err)
	}
	value := <-done
	if len(value["skipped"].([]string)) != 1 {
		t.Fatal("skip not reported", value)
	}
	reused, err := e.askQuestion(context.Background(), s, call)
	if err != nil || obj(reused)["reused"] != true {
		t.Fatal("same question asked again", reused, err)
	}
	view, _ := e.Snapshot("case")
	if view.Question != nil {
		t.Fatal("repeated skipped question displayed")
	}
	prompt := Prompt(Config{Profile: "core"})
	for _, rule := range []string{"Do not begin every task with a questionnaire", "Do not re-ask a decision already settled", "read-only tool", "required target"} {
		if !strings.Contains(prompt, rule) {
			t.Fatal("context decision rule missing", rule)
		}
	}
}
