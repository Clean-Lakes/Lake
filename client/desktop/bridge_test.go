package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type bridgeBuffer struct{ bytes.Buffer }

func (*bridgeBuffer) Close() error { return nil }

func TestDesktopAskIsOnlyProtocolPresentation(t *testing.T) {
	input := &bridgeBuffer{}
	app := &App{stdin: input, conversationID: "conversation"}
	if err := app.ReformatResult("turn", "整理已有结果"); err != nil {
		t.Fatal(err)
	}
	var request struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(input.Bytes(), &request); err != nil {
		t.Fatal(err)
	}
	if request.ID != "turn" || request.Method != "conversation.ask" || request.Params["id"] != "conversation" || request.Params["review_only"] != true {
		t.Fatal(request)
	}
	if err := app.Ask("next", "blocked"); err == nil {
		t.Fatal("accepted concurrent turn")
	}
	app.emit(map[string]any{"type": "result", "id": "turn"})
	if err := app.Ask("next", "native history resume"); err != nil {
		t.Fatal(err)
	}
}

func TestResponsesRemainResponsiveDuringActiveTurn(t *testing.T) {
	var methods []string
	app := &App{activeTurn: "turn", rpcCall: func(method string, params map[string]any) (json.RawMessage, error) {
		methods = append(methods, method)
		return json.RawMessage(`null`), nil
	}}
	if err := app.Approve("native-request", true); err != nil {
		t.Fatal(err)
	}
	if err := app.AnswerQuestion("turn", "question", map[string]string{"q0": "继续"}); err != nil {
		t.Fatal(err)
	}
	if app.activeTurn != "turn" || len(methods) != 2 || methods[0] != "approval.respond" || methods[1] != "question.answer" {
		t.Fatal(methods)
	}
	if err := app.AnswerQuestion("turn", "question", map[string]string{"q0": ""}); err == nil {
		t.Fatal("empty answer accepted")
	}
}

func TestAsyncRPCFailureClearsBusyPresentation(t *testing.T) {
	script := filepath.Join(t.TempDir(), "lake")
	// A protocol fixture rejects admission before it can emit a turn event.
	if err := os.WriteFile(script, []byte("#!/bin/sh\nwhile IFS= read -r line; do\n echo '{\"id\":\"turn\",\"error\":\"fixture admission rejected\"}'\ndone\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_CLI_PATH", script)
	events := make(chan map[string]any, 8)
	app := NewApp()
	app.ctx = context.Background()
	app.conversationID = "conversation"
	var eventsMu sync.Mutex
	app.taskEvent = func(_ string, value any) { eventsMu.Lock(); defer eventsMu.Unlock(); events <- value.(map[string]any) }
	t.Cleanup(func() { app.shutdown(context.Background()) })
	if err := app.Ask("turn", "fixture"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event["type"] != "error" || event["id"] != "turn" {
			t.Fatal(event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing failure event")
	}
	app.mu.Lock()
	active := app.activeTurn
	app.mu.Unlock()
	if active != "" {
		t.Fatal("busy presentation survived rejection")
	}
}

func TestExistingDesktopMethodsRemainAvailable(t *testing.T) {
	data, err := os.ReadFile("../../third_party/zcode/apps/zcode-cli/packages/lake/test/desktop-methods.json")
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		Methods []struct {
			Method string `json:"method"`
			Status string `json:"status"`
		}
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory.Methods) != 75 {
		t.Fatal("unexpected frontend method count", len(inventory.Methods))
	}
	methods := reflect.TypeOf(&App{})
	for _, entry := range inventory.Methods {
		if _, ok := methods.MethodByName(entry.Method); !ok || entry.Status == "pending" {
			t.Fatal("missing frontend method", entry.Method)
		}
	}
}
