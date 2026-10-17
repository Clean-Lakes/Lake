package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAcknowledgementClassifierDoesNotConsumeConcreteRequests(t *testing.T) {
	for _, text := range []string{"好的。", "谢谢", "你好", "收到"} {
		if !IsBriefConversation(text) {
			t.Fatal("missing acknowledgement", text)
		}
	}
	for _, text := range []string{"", "继续", "好的，继续检查内存", "谢谢，请删除指定文件", "查看磁盘情况", "重试重启指定服务", "再试试删除文件"} {
		if IsBriefConversation(text) {
			t.Fatal("concrete instruction became an acknowledgement", text)
		}
	}
}

func TestRunningShellOutputReturnsPartialAndWaitHasShortDeadline(t *testing.T) {
	e := &Engine{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	job := &shellJob{id: "job", session: "case", status: "running", terminalID: "terminal", entryID: "entry", cancel: cancel, done: make(chan struct{})}
	e.shells.Store("case:job", job)
	e.Bridge = func(ctx context.Context, id, name string, a map[string]any, approved bool) (any, error) {
		if name != "terminal_command_status" || a["entry_id"] != "entry" {
			t.Fatal("unexpected partial-output request")
		}
		return map[string]any{"output": "partial evidence", "partial": true}, nil
	}
	value, err := e.shellJob(ctx, "case", "shell_output", map[string]any{"shell_id": "job"})
	if err != nil || !strings.Contains(js(value), "partial evidence") {
		t.Fatal("partial output missing", err)
	}
	start := time.Now()
	value, err = e.shellJob(ctx, "case", "wait_shell", map[string]any{"shell_id": "job", "timeout_ms": 180000})
	if err != nil || str(obj(value)["status"]) != "running" || time.Since(start) > 6*time.Second {
		t.Fatal("long wait still blocked the turn", err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("bounded wait cancelled the underlying command")
	default:
	}
	cancel()
	if _, err = e.shellJob(ctx, "case", "wait_shell", map[string]any{"shell_id": "job"}); !errors.Is(err, context.Canceled) {
		t.Fatal("explicit cancellation was swallowed")
	}
}

func TestRepeatedUnchangedBackgroundPollingFinishesTurn(t *testing.T) {
	var calls atomic.Int32
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		calls.Add(1)
		return response("", Call{ID: "poll", Name: "shell_output", Arguments: `{"shell_id":"running-job"}`})
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	backgroundDone := make(chan struct{})
	// 合成任务没有实际 worker；测试结束时显式完成它，让 Shutdown 可以等待任务收尾。
	t.Cleanup(func() { close(backgroundDone) })
	e.shells.Store("case:running-job", &shellJob{id: "running-job", session: "case", status: "running", done: backgroundDone, cancel: func() {}})
	if err := e.Chat(context.Background(), "case", "查看后台进度", nil); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	if view.Status != "completed" || calls.Load() != 3 || !strings.Contains(view.Cards[len(view.Cards)-1].Content, "停止重复等待") {
		t.Fatal("unchanged polling kept the conversation active")
	}
	job, _ := e.shells.Load("case:running-job")
	if job.(*shellJob).status != "running" {
		t.Fatal("finishing a reply falsely completed the command")
	}
}

func TestWorkBetweenPollsKeepsWaiting(t *testing.T) {
	ctx := boundedShellPolling(context.Background())
	poll := Call{Name: "shell_output", Arguments: `{"shell_id":"job"}`}
	status := map[string]any{"status": "running", "result": "unchanged"}
	// 轮询间隙执行其他命令是真实进展，不算重复询问，长任务等待期间不应终止整轮。
	for i := 0; i < 4; i++ {
		if err := shellPollingProgress(ctx, poll, status); err != nil {
			t.Fatal("poll after real work paused the wait", err)
		}
		if err := shellPollingProgress(ctx, Call{Name: "shell", Arguments: `{}`}, map[string]any{"status": "ok"}); err != nil {
			t.Fatal("unrelated tool call treated as a poll", err)
		}
	}
	// 连续三次没有新信息的轮询仍然停止整轮。
	for i := 0; i < 2; i++ {
		if err := shellPollingProgress(ctx, poll, status); err != nil {
			t.Fatal("consecutive polls bounded too early", err)
		}
	}
	if err := shellPollingProgress(ctx, poll, status); err == nil {
		t.Fatal("consecutive unchanged polling was not bounded")
	}
}

func TestNewOutputResetsPollingGuard(t *testing.T) {
	ctx := boundedShellPolling(context.Background())
	call := Call{Name: "shell_output", Arguments: `{"shell_id":"job"}`}
	for _, output := range []string{"first", "first", "second", "second", "third", "third"} {
		if err := shellPollingProgress(ctx, call, map[string]any{"status": "running", "result": output}); err != nil {
			t.Fatal("new output did not reset no-progress guard")
		}
	}
}
