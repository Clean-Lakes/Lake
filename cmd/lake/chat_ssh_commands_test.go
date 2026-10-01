package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
)

func TestLocalSSHSessionsCommand(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	handled, err := runLocalSSHCommand(ctx, service, "/sessions", &out, nil)
	if !handled || err != nil || !strings.Contains(out.String(), "没有挂起的 SSH 连接") {
		t.Fatalf("handled=%t err=%v output=%q", handled, err, out.String())
	}
	out.Reset()
	handled, err = runLocalSSHCommand(ctx, service, "/ssh ls", &out, nil)
	if !handled || err != nil || !strings.Contains(out.String(), "没有挂起的 SSH 连接") {
		t.Fatalf("handled=%t err=%v output=%q", handled, err, out.String())
	}
}
