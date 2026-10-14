package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSanitizeSessionTitle(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  string
	}{
		{"\n- 标题： ‘MongoDB 服务异常排查。’\n补充说明", "MongoDB 服务异常排查"},
		{"Title: \"NFS 服务器定位!\"", "NFS 服务器定位"},
		{"只检查本机终端会话", "只检查本机终端会话"},
		{"---\n   ", ""},
	} {
		if got := sanitizeSessionTitle(tc.input); got != tc.want {
			t.Errorf("sanitizeSessionTitle(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
	long := sanitizeSessionTitle(strings.Repeat("MongoDB", 8))
	if len([]rune(long)) != 25 || !strings.HasSuffix(long, "…") {
		t.Fatalf("long title was not bounded: %q", long)
	}
}

func TestSessionTitleWorkerGeneratesTitleOnceAndKeepsManualRename(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "AI title"}, 201)
	session := apiTest(t, h, "POST", "/api/projects/"+stringOf(project["id"])+"/sessions", Object{}, 201)
	id := stringOf(session["id"])

	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(started)
		<-release
		emitModel(w, "标题：‘MongoDB 服务异常排查。’", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "title fixture", Protocol: "openai"})

	userText := "@MongoDB 主机 MongoDB 好像挂了 @10.100.33.52"
	input := b.humanMessageTitle(humanMessage{Text: userText, References: []Object{{"name": "MongoDB 主机"}}})
	if strings.Contains(input, "synthetic-title-key") || strings.HasPrefix(input, "@MongoDB 主机") {
		t.Fatalf("title input was not safely normalized: %q", input)
	}
	pending := b.Store.PendingSessionNaming(id)
	b.Store.Begin(id, userText, nil, input)
	if !pending {
		t.Fatal("new session did not opt in to automatic naming")
	}
	if got, want := stringOf(b.Store.Session(id)["title"]), sessionTitle(input); got != want {
		t.Fatalf("local placeholder = %q, want %q", got, want)
	}

	b.generateSessionTitle(id, input)
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("title model call did not start")
	}
	b.Store.RenameSession(id, "用户手动标题")
	close(release)
	b.workers.Wait()
	if got := stringOf(b.Store.Session(id)["title"]); got != "用户手动标题" {
		t.Fatalf("late AI title replaced manual title: %q", got)
	}
	if calls.Load() != 1 {
		t.Fatalf("model calls = %d, want one", calls.Load())
	}
	if b.Store.PendingSessionNaming(id) {
		t.Fatal("manual rename left automatic naming enabled")
	}
}

func TestSessionTitleStartsFromMessageAndDoesNotRepeat(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "AI title end to end"}, 201)
	session := apiTest(t, h, "POST", "/api/projects/"+stringOf(project["id"])+"/sessions", Object{}, 201)
	id := stringOf(session["id"])
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode model request: %v", err)
		}
		if calls.Add(1) == 1 {
			emitModel(w, "MongoDB 服务异常排查", nil)
			return
		}
		messages := objects(request["messages"])
		if len(messages) > 0 && messages[0]["role"] == "system" && strings.Contains(stringOf(messages[0]["content"]), "运维调查会话起标题") {
			emitModel(w, "MongoDB 服务异常排查", nil)
			return
		}
		emitModel(w, "我会检查 MongoDB 服务状态。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "title integration fixture", Protocol: "openai"})

	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "@MongoDB 主机 @10.100.33.52 的 mongodb 好像挂了"}, 202)
	b.workers.Wait()
	if got := stringOf(b.Store.Session(id)["title"]); got != "MongoDB 服务异常排查" {
		t.Fatalf("AI title = %q", got)
	}
	if calls.Load() != 2 {
		t.Fatalf("first turn made %d model calls, want dialogue and title", calls.Load())
	}

	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "继续看一下日志"}, 202)
	b.workers.Wait()
	if calls.Load() != 3 {
		t.Fatalf("second turn made %d total model calls, want dialogue only", calls.Load())
	}
	if got := stringOf(b.Store.Session(id)["title"]); got != "MongoDB 服务异常排查" {
		t.Fatalf("second turn replaced title with %q", got)
	}
}

func TestSensitiveSessionInputDoesNotCallTitleModel(t *testing.T) {
	if shouldGenerateSessionTitle("api_key: synthetic-private-value") {
		t.Fatal("credential input should use the generic local title")
	}
	if !shouldGenerateSessionTitle("检查 MongoDB 服务状态") {
		t.Fatal("ordinary investigation input should generate a title")
	}
}

func TestSessionTitleWorkerFailureKeepsLocalTitle(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "AI title failure"}, 201)
	session := apiTest(t, h, "POST", "/api/projects/"+stringOf(project["id"])+"/sessions", Object{}, 201)
	id := stringOf(session["id"])
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"MongoDB 服务异常排查\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "title failure fixture", Protocol: "openai"})
	input := "检查本机内存和进程资源占用"
	pending := b.Store.PendingSessionNaming(id)
	b.Store.Begin(id, input, nil, input)
	if pending {
		b.generateSessionTitle(id, input)
		b.workers.Wait()
	}
	if got := stringOf(b.Store.Session(id)["title"]); got != input {
		t.Fatalf("provider failure changed local title: %q", got)
	}
}
