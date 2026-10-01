package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/code"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/store"
)

func TestCodeSpecialistUsesProfileAndPersistsTask(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	workspace, err := code.Open(project)
	if err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if requests == 1 {
			found := false
			for _, item := range body.Tools {
				if item.Name == "lake_code_read" {
					found = true
				}
			}
			if !found {
				t.Error("code read missing from specialist whitelist")
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"read-1","name":"lake_code_read","input":{"path":"main.go"}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"main.go 是 Go 程序。"}]}`))
	}))
	defer server.Close()
	model := &lakemodel.Anthropic{BaseURL: server.URL + "/anthropic", Model: "test", APIKey: []byte("test-key")}
	agentTool, err := newCodeAgentTool(ctx, model, workspace, nil, specialistExecution{Root: root, LakeID: "lake", SessionID: "run-code", ModelID: "test", Store: s})
	if err != nil {
		t.Fatal(err)
	}
	result, err := agentTool.(tool.InvokableTool).InvokableRun(ctx, `{"request":"读取 main.go"}`)
	if err != nil || requests != 2 || !strings.Contains(result, "Go 程序") {
		t.Fatalf("result=%q requests=%d err=%v", result, requests, err)
	}
	tasks, err := s.ListSpecialistTasks(ctx, "run-code")
	if err != nil || len(tasks) != 1 || tasks[0].Status != "completed" || tasks[0].Name != "lake_code_agent" || !strings.Contains(tasks[0].ScopeJSON, workspace.Root) {
		t.Fatalf("tasks=%+v err=%v", tasks, err)
	}
}
