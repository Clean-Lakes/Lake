package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestRemoteCodeCLIRequiresSeparateAuthorizationAndTTYApproval(t *testing.T) {
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
	conversation, err := s.CreateConversation(ctx, "ops")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateCodeWorkspace(ctx, lake.ID, host.ID, "repo", "/srv/repo")
	if err != nil {
		t.Fatal(err)
	}
	call := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		err := codeProjectCommand(ctx, s, append([]string{"remote"}, args...), strings.NewReader("yes\n"), &out, &errOut)
		return out.String(), err
	}
	if _, err := call("bind", conversation.ID, workspace.ID); err == nil {
		t.Fatal("disabled workspace bound")
	}
	if _, err := call("files", workspace.ID); err == nil {
		t.Fatal("disabled workspace read")
	}
	if _, err := call("authz", workspace.ID, "on"); err != nil {
		t.Fatal(err)
	}
	raw, err := call("bind", conversation.ID, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	var bound store.Conversation
	if err := json.Unmarshal([]byte(raw), &bound); err != nil || bound.RemoteWorkspaceID != workspace.ID {
		t.Fatalf("conversation=%+v err=%v", bound, err)
	}
	if _, err := call("run", workspace.ID, "--command", "printf hello"); err == nil {
		t.Fatal("non-TTY remote command was approved")
	}
}
