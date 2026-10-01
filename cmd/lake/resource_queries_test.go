package main

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestResourceInventoryChoosesLongestNamedLake(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "湖", ""); err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "real-host",
		SSH: store.SSHSpec{Host: "192.0.2.1", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	answer, handled, err := answerResourceInventory(ctx, s, "去测试湖里面看有什么资源")
	if err != nil || !handled || !strings.Contains(answer, "real-host") || strings.Contains(answer, "湖共有 0") {
		t.Fatalf("handled=%t err=%v answer=%q", handled, err, answer)
	}
	if isResourceInventoryQuestion("去这台服务器里看一下它的CPU占用多少") {
		t.Fatal("CPU check must reach SSH specialist")
	}
}

func TestExactResourceMentionDisplaysStoredRecord(t *testing.T) {
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
	_, err = s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "web 01", Env: "test", Tags: map[string]string{"role": "web"},
		SSH: store.SSHSpec{Host: "192.0.2.1", Port: 22, Username: "root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	answer, handled, err := answerResourceInventory(ctx, s, "@测试湖/web 01")
	if err != nil || !handled || !strings.Contains(answer, "root@192.0.2.1:22") || !strings.Contains(answer, "执行授权：未开启") {
		t.Fatalf("handled=%t err=%v answer=%q", handled, err, answer)
	}
	answer, handled, err = answerResourceInventory(ctx, s, "@测试湖/missing")
	if err != nil || !handled || !strings.Contains(answer, "没有找到资源") {
		t.Fatalf("handled=%t err=%v answer=%q", handled, err, answer)
	}
	_, handled, err = answerResourceInventory(ctx, s, "检查 @测试湖/web 01 的 CPU")
	if err != nil || handled {
		t.Fatalf("operation must reach SSH Agent: handled=%t err=%v", handled, err)
	}
}
