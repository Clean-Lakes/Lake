package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
	"testing"
)

func TestUnnamedSessionNamesFromFirstMeaningfulMessage(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "auto titles"}, 201)
	path := "/api/projects/" + stringOf(project["id"]) + "/sessions"
	session := apiTest(t, h, "POST", path, Object{}, 201)
	id := stringOf(session["id"])
	if session["title"] != "新会话" {
		t.Fatal("creation required a manual name")
	}
	b.Store.Begin(id, "你好", nil)
	b.Store.Status(id, "completed")
	if b.Store.Session(id)["title"] != "新会话" {
		t.Fatal("greeting prematurely named session")
	}
	b.Store.Begin(id, "检查本机内存和进程资源占用", nil)
	b.Store.Status(id, "completed")
	if b.Store.Session(id)["title"] != "检查本机内存和进程资源占用" {
		t.Fatal("first meaningful message did not name session")
	}
	b.Store.Begin(id, "现在继续看磁盘", nil)
	b.Store.Status(id, "completed")
	if b.Store.Session(id)["title"] != "检查本机内存和进程资源占用" {
		t.Fatal("stable name was replaced by later message")
	}
	manual := apiTest(t, h, "POST", path, Object{"title": "原有名称"}, 201)
	manualID := stringOf(manual["id"])
	b.Store.Begin(manualID, "不能覆盖我的名称", nil)
	if b.Store.Session(manualID)["title"] != "原有名称" {
		t.Fatal("manual name changed")
	}
	// Naming bookkeeping is removed with the conversation.
	b.Store.DeleteSession(id)
	record := b.Store.read(func() any { return b.Store.row("SELECT 1 FROM sessionNaming WHERE sessionId=?", id) })
	if record.(Object) != nil {
		t.Fatal("naming record left after deletion")
	}
	apiTest(t, h, "POST", path, Object{"title": true}, 400)
}
func TestGeneratedSessionTitleCannotReplaceExplicitRename(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	project := s.CreateProject("title lock")
	auto := s.CreateSession(stringOf(project["id"]), "", nil)
	autoID := stringOf(auto["id"])
	if !s.PendingSessionNaming(autoID) {
		t.Fatal("unnamed session was not pending naming")
	}
	s.Begin(autoID, "检查MongoDB服务", nil)
	if s.PendingSessionNaming(autoID) {
		t.Fatal("local placeholder did not claim automatic naming")
	}
	if !s.SetGeneratedTitle(autoID, "MongoDB 服务异常排查") {
		t.Fatal("AI title was not accepted")
	}
	if got := stringOf(s.Session(autoID)["title"]); got != "MongoDB 服务异常排查" {
		t.Fatalf("generated title = %q", got)
	}

	locked := s.CreateSession(stringOf(project["id"]), "", nil)
	lockedID := stringOf(locked["id"])
	s.RenameSession(lockedID, "用户手动命名")
	if s.PendingSessionNaming(lockedID) || s.SetGeneratedTitle(lockedID, "AI 覆盖标题") {
		t.Fatal("automatic naming overwrote an explicit rename")
	}
	if got := stringOf(s.Session(lockedID)["title"]); got != "用户手动命名" {
		t.Fatalf("manual title changed to %q", got)
	}
}

func TestGeneratedSessionTitleFormattingAndPrivateInput(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"\n# 检查内存\n详细说明", "检查内存"},
		{"@Local machine 内存状态", "Local machine 内存状态"},
		{"请分析附加图片。", "图片分析"},
		{"api_key: synthetic-private-value", "凭据配置"},
		{"密码： synthetic-secret-value", "凭据配置"},
		{"已处理 [PRIVATE KEY REDACTED]", "凭据配置"},
		{"hello!", ""},
	} {
		if got := sessionTitle(tc.input); got != tc.want {
			t.Errorf("title %q, want %q", got, tc.want)
		}
	}
	title := sessionTitle(strings.Repeat("内存", 30))
	if len([]rune(title)) != 29 || !strings.HasSuffix(title, "…") {
		t.Fatal("long unicode title was not bounded")
	}
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := s.Dir
	p := s.CreateProject("p")
	session := s.CreateSession(stringOf(p["id"]), "", nil)
	id := stringOf(session["id"])
	s.Begin(id, "请检查系统负载", nil)
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Session(id)["title"] != "请检查系统负载" {
		t.Fatal("auto title did not survive restart")
	}
}

func TestTitleRedactsExactKeysWithoutStreamingSuffixFalsePositives(t *testing.T) {
	b, _ := fixture(t)
	b.Models.Save(&ai.Model{URL: "http://localhost:9/v1/chat/completions", Name: "title fixture", Protocol: "openai", Key: "synthetic-title-key"})
	if got := b.Terminals.titleInput("inspect processes"); got != "inspect processes" {
		t.Fatal("normal word ending mistaken for credential prefix")
	}
	input := b.Terminals.titleInput("configure api_key synthetic-title-key")
	if strings.Contains(input, "synthetic-title-key") || sessionTitle(input) != "凭据配置" {
		t.Fatal("model key exposed in title")
	}
}
