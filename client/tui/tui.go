package tui

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

// API sends the TUI through the same read-only, versioned HTTP handler as Web.
// It uses an in-process recorder, so no local listener or bearer token exists.
type API struct{ Handler http.Handler }

func (a API) get(ctx context.Context, path string, into any) error {
	if a.Handler == nil {
		return errors.New("TUI 会话 API 未配置")
	}
	request := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
	response := httptest.NewRecorder()
	a.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		return fmt.Errorf("TUI 会话 API 返回 HTTP %d", response.Code)
	}
	return json.Unmarshal(response.Body.Bytes(), into)
}

type key byte

const (
	keyUp key = iota + 1
	keyDown
	keyEnter
	keyBack
	keyRefresh
	keyHelp
	keyQuit
)

func readKeys(input io.Reader) <-chan key {
	out := make(chan key, 16)
	go func() {
		defer close(out)
		reader := bufio.NewReader(input)
		for {
			b, err := reader.ReadByte()
			if err != nil {
				return
			}
			var value key
			switch b {
			case 'k':
				value = keyUp
			case 'j':
				value = keyDown
			case '\n', '\r':
				value = keyEnter
			case 'b':
				value = keyBack
			case 'r':
				value = keyRefresh
			case '?':
				value = keyHelp
			case 'q', 3:
				value = keyQuit
			case 27:
				if next, e := reader.ReadByte(); e == nil && next == '[' {
					if direction, e := reader.ReadByte(); e == nil {
						if direction == 'A' {
							value = keyUp
						} else if direction == 'B' {
							value = keyDown
						}
					}
				}
			}
			if value != 0 {
				out <- value
			}
		}
	}()
	return out
}

type state struct {
	api           API
	out           io.Writer
	conversations []store.Conversation
	selected      int
	active        string
	cursor        uint64
	seenTurns     map[string]bool
	model         string
	runStatus     string
	pending       map[string]string
}

// Run provides a text-first terminal interface. Every control has a readable
// label; arrow keys and j/k navigate, Enter opens, b returns, r refreshes.
func Run(ctx context.Context, api API, input io.Reader, out io.Writer) error {
	view := &state{api: api, out: out, seenTurns: make(map[string]bool)}
	if err := view.refreshList(ctx); err != nil {
		return err
	}
	view.renderList()
	keys := readKeys(input)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, open := <-keys:
			if !open || event == keyQuit {
				_, _ = fmt.Fprintln(out, "已退出 Lake TUI")
				return nil
			}
			if err := view.handle(ctx, event); err != nil {
				_, _ = fmt.Fprintln(out, "错误：", err)
			}
		case <-ticker.C:
			if view.active != "" {
				if err := view.poll(ctx, false); err != nil {
					_, _ = fmt.Fprintln(out, "连接状态：", err)
				}
			}
		}
	}
}

func (s *state) refreshList(ctx context.Context) error {
	var items []store.Conversation
	if err := s.api.get(ctx, "/api/v1/conversations", &items); err != nil {
		return err
	}
	s.conversations = items
	if s.selected >= len(items) {
		s.selected = max(0, len(items)-1)
	}
	return nil
}

func (s *state) renderList() {
	_, _ = fmt.Fprintln(s.out, "Lake TUI · 会话列表")
	for i, item := range s.conversations {
		mark := " "
		if i == s.selected {
			mark = ">"
		}
		_, _ = fmt.Fprintf(s.out, "%s %d. [%s] %s\n", mark, i+1, item.Lake, item.Title)
	}
	if len(s.conversations) == 0 {
		_, _ = fmt.Fprintln(s.out, "暂无会话")
	}
	_, _ = fmt.Fprintln(s.out, "操作：↑/↓ 或 k/j 选择；Enter 查看；r 刷新；? 帮助；q 退出")
}

func (s *state) handle(ctx context.Context, event key) error {
	switch event {
	case keyHelp:
		_, _ = fmt.Fprintln(s.out, "帮助：↑/↓ 或 k/j 切换会话，Enter 查看，b 返回列表，r 刷新，q 退出。此入口只读；待审批动作请回发起入口处理。")
	case keyBack:
		s.active = ""
		s.cursor = 0
		s.renderList()
	case keyUp, keyDown:
		if len(s.conversations) == 0 {
			return nil
		}
		step := 1
		if event == keyUp {
			step = -1
		}
		s.selected = (s.selected + step + len(s.conversations)) % len(s.conversations)
		if s.active != "" {
			return s.open(ctx, s.conversations[s.selected])
		}
		s.renderList()
	case keyEnter:
		if len(s.conversations) > 0 {
			return s.open(ctx, s.conversations[s.selected])
		}
	case keyRefresh:
		if err := s.refreshList(ctx); err != nil {
			return err
		}
		if s.active != "" {
			return s.poll(ctx, true)
		}
		s.renderList()
	}
	return nil
}

func (s *state) open(ctx context.Context, item store.Conversation) error {
	s.active, s.cursor = item.ID, 0
	s.seenTurns = make(map[string]bool)
	s.model, s.runStatus = "", "未运行"
	s.pending = make(map[string]string)
	_, _ = fmt.Fprintf(s.out, "会话：%s；湖：%s\n", item.Title, item.Lake)
	if item.ProjectPath != "" {
		_, _ = fmt.Fprintf(s.out, "工作区：本机 %s\n", item.ProjectPath)
	}
	if item.RemoteWorkspaceID != "" {
		_, _ = fmt.Fprintf(s.out, "工作区：远程 %s@%s:%d%s\n", item.RemoteUsername, item.RemoteHost, item.RemotePort, item.RemoteRoot)
	}
	_, _ = fmt.Fprintln(s.out, "操作：↑/↓ 切换会话；b 返回；r 刷新；q 退出。审批请回发起入口。")
	return s.poll(ctx, true)
}

func (s *state) poll(ctx context.Context, initial bool) error {
	if s.active == "" {
		return nil
	}
	path := "/api/v1/conversations/" + url.PathEscape(s.active)
	var turns []store.ConversationTurn
	if err := s.api.get(ctx, path+"/turns", &turns); err != nil {
		return err
	}
	start := 0
	if initial && len(turns) > 15 {
		start = len(turns) - 15
	}
	for _, turn := range turns[start:] {
		if s.seenTurns[turn.ID] {
			continue
		}
		s.seenTurns[turn.ID] = true
		_, _ = fmt.Fprintf(s.out, "用户：%s\n", readable(turn.Prompt, 4000))
		if turn.Error != "" {
			_, _ = fmt.Fprintf(s.out, "运行错误：%s\n", readable(turn.Error, 1000))
		}
		if turn.Answer != "" {
			_, _ = fmt.Fprintf(s.out, "助手：%s\n", readable(turn.Answer, 6000))
		}
		for _, call := range turn.Specialists {
			_, _ = fmt.Fprintf(s.out, "专员：%s；状态：%s；任务：%s\n", call.Kind, call.Stage, readable(call.Task, 200))
			for _, step := range call.Steps {
				_, _ = fmt.Fprintf(s.out, "工作流步骤：%s；状态：%s\n", step.Name, step.Status)
			}
		}
	}
	var summaries []string
	for {
		var events []agent.AgentEvent
		if err := s.api.get(ctx, fmt.Sprintf("%s/events?after=%d&limit=500", path, s.cursor), &events); err != nil {
			return err
		}
		for _, event := range events {
			if event.Version != 1 || string(event.SessionID) != s.active || event.Sequence != s.cursor+1 {
				return errors.New("事件序号不连续或协议版本不匹配")
			}
			s.cursor = event.Sequence
			s.applyStatus(event)
			if line := eventLine(event); line != "" {
				summaries = append(summaries, line)
			}
		}
		if len(events) < 500 {
			break
		}
	}
	if initial && len(summaries) > 20 {
		summaries = summaries[len(summaries)-20:]
	}
	for _, line := range summaries {
		_, _ = fmt.Fprintln(s.out, line)
	}
	if initial {
		_, _ = fmt.Fprintf(s.out, "模型：%s；运行状态：%s；待审批动作：%d\n", emptyLabel(s.model), s.runStatus, len(s.pending))
	}
	return nil
}

func emptyLabel(value string) string {
	if value == "" {
		return "未选择"
	}
	return value
}

func (s *state) applyStatus(event agent.AgentEvent) {
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return
	}
	value, _ := payload["model"].(string)
	switch event.Kind {
	case "run_started":
		s.model, s.runStatus = value, "运行中"
	case "run_failed":
		s.runStatus = "运行失败"
	case "answer_finished":
		s.runStatus = "已完成"
	case "tool_proposed":
		if strings.Contains(string(event.ToolCallID), "-approval-") {
			s.pending[string(event.ToolCallID)], _ = payload["tool_name"].(string)
		}
	case "tool_decision", "tool_finished":
		delete(s.pending, string(event.ToolCallID))
	}
}

func readable(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) > limit {
		return value[:limit] + "…"
	}
	return value
}

func eventLine(event agent.AgentEvent) string {
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return ""
	}
	str := func(key string) string { value, _ := payload[key].(string); return readable(value, 300) }
	switch event.Kind {
	case "run_started":
		return "运行中；模型：" + str("model")
	case "tool_proposed":
		if strings.Contains(string(event.ToolCallID), "-approval-") {
			return "待审批动作：" + str("tool_name") + "；目标：" + str("target") + "。请回发起入口审批。"
		}
		return "工具调用：" + str("tool_name")
	case "tool_decision":
		return "审批结果：" + str("outcome")
	case "tool_finished":
		return "工具状态：" + str("status")
	case "specialist":
		return "专员：" + str("name") + "；状态：" + str("status")
	case "workflow":
		return fmt.Sprintf("工作流：%s；状态：%s；步骤：%s；步骤状态：%s；进度：%.0f/%.0f", str("name"), str("status"), str("step_name"), str("step_status"), payload["completed"], payload["total"])
	case "run_failed":
		return "运行失败：" + str("reason")
	case "answer_finished":
		return "运行状态：" + str("status")
	default:
		return ""
	}
}
