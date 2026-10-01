package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestTerminalProgressClearsBeforeOtherOutput(t *testing.T) {
	var out bytes.Buffer
	progress := newTerminalProgress(&out, true)
	progress.Start("Lake Agent 正在处理")
	progress.SetLabel("SSH 专员正在处理")
	progress.Pause()
	progress.SetLabel("Lake Agent 正在整理结果")
	progress.Resume()
	progress.Stop()
	progress.Stop()
	if !strings.Contains(out.String(), "Lake Agent 正在处理") || !strings.Contains(out.String(), "SSH 专员正在处理") || !strings.Contains(out.String(), "Lake Agent 正在整理结果") || !strings.HasSuffix(out.String(), "\r\x1b[2K") {
		t.Fatalf("progress was not cleared: %q", out.String())
	}
	out.Reset()
	progress = newTerminalProgress(&out, false)
	progress.Start("隐藏")
	progress.Stop()
	if out.Len() != 0 {
		t.Fatalf("non-terminal output contains progress control codes: %q", out.String())
	}
}
