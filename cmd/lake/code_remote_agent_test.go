package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/code/remote"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type remoteTestKeys struct{}

func (remoteTestKeys) Load(string) ([]byte, error) { return []byte("fake-key"), nil }

type remoteTestRunner struct{}

func (remoteTestRunner) RunWithInput(context.Context, sshtransport.Target, []byte, string, []byte) (sshtransport.Result, error) {
	return sshtransport.Result{Stdout: "./main.go\x00"}, nil
}

func TestRemoteCodeSpecialistUsesOnlyBoundRemoteTools(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "node", SSH: store.SSHSpec{Host: "example.test", Port: 22, Username: "ops"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateCodeWorkspace(ctx, lake.ID, host.ID, "repo", "/srv/repo")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err = s.SetCodeWorkspaceAuthorized(ctx, workspace.ID, true)
	if err != nil {
		t.Fatal(err)
	}
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
			remoteList, localList := false, false
			for _, item := range body.Tools {
				if item.Name == "lake_remote_code_list" {
					remoteList = true
				}
				if item.Name == "lake_code_list" {
					localList = true
				}
			}
			if !remoteList || localList {
				t.Errorf("remote=%v local=%v", remoteList, localList)
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"list-1","name":"lake_remote_code_list","input":{}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"远端有 main.go。"}]}`))
	}))
	defer server.Close()
	model := &lakemodel.Anthropic{BaseURL: server.URL + "/anthropic", Model: "test", APIKey: []byte("test-key")}
	service := remote.Service{Store: s, Runner: remoteTestRunner{}, Keys: remoteTestKeys{}, Origin: "model", Actor: "agent"}
	agentTool, err := newRemoteCodeAgentTool(ctx, model, workspace, service, specialistExecution{Root: s.Root(), LakeID: lake.ID, SessionID: "remote-run", ModelID: "test", Store: s})
	if err != nil {
		t.Fatal(err)
	}
	result, err := agentTool.(tool.InvokableTool).InvokableRun(ctx, `{"request":"查看远程文件"}`)
	if err != nil || requests != 2 || !strings.Contains(result, "main.go") {
		t.Fatalf("result=%q requests=%d err=%v", result, requests, err)
	}
}
