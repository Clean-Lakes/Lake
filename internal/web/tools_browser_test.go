package web

import (
	"encoding/json"
	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Optional real-browser fixture; no credentials, production data or external model calls.
// LAKE_TOOLS_BROWSER=1 go test ./internal/web -run TestToolsBrowserFixture -v
// Create /tmp/lake-tools-browser.done after browser validation to close it.
func TestToolsBrowserFixture(t *testing.T) {
	if os.Getenv("LAKE_TOOLS_BROWSER") != "1" {
		t.Skip("manual browser fixture")
	}
	b, h := fixture(t)
	id, _ := newSession(t, h)
	b.options.Static = webassets.Files()
	u, _ := url.Parse(h.URL)
	port, _ := strconv.Atoi(u.Port())
	b.options.Port = port
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(jsonText(body["tools"]), "todo_write") {
			emitModel(w, "fixture metadata", nil)
			return
		}
		n := calls.Add(1)
		if n == 1 {
			emitModel(w, "先确认本次调查目标。", []ai.Call{
				{ID: "todos", Name: "todo_write", Arguments: `{"todos":[{"content":"选择调查目标","status":"in_progress"},{"content":"整理调查结果","status":"pending"}]}`},
				{ID: "question", Name: "ask_user_question", Arguments: `{"questions":[{"id":"scope","title":"这次调查的重点是什么？","reason":"不同重点需要采集不同证据，可合并选择。","multi_select":true,"options":[{"label":"整体架构与 API","description":"梳理模块边界、接口和调用关系","recommended":true},{"label":"核心业务与日志","description":"检查主要业务流程及应用错误日志"},{"label":"数据库与缓存","description":"检查连接、慢查询和缓存状态"}]},{"id":"target","title":"选择本次调查目标","options":["测试环境","生产环境"]}]}`},
			})
		} else if n == 2 {
			emitModel(w, "已收到你的范围选择，继续独立调查。", []ai.Call{{ID: "done", Name: "todo_write", Arguments: `{"todos":[{"content":"选择调查目标","status":"completed"},{"content":"整理调查结果","status":"completed"}]}`}})
		} else {
			emitModel(w, "已继续完成本次调查。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "本地问答测试", Protocol: "openai"})
	b.submitHumanMessage(id, Object{"text": "请选择本次调查目标"})
	t.Logf("BROWSER_FIXTURE_URL=%s/?session=%s#token=synthetic-test-auth-token", h.URL, id)
	timer := time.NewTimer(4 * time.Minute)
	defer timer.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-timer.C:
			t.Fatal("browser fixture timed out")
		case <-ticker.C:
			if _, err := os.Stat("/tmp/lake-tools-browser.done"); err == nil {
				return
			}
		}
	}
}
