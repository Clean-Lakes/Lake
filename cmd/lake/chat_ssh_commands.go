package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/cloudwego/eino/lake/operate"
)

// Session commands stay local to this Lake Agent process. A separate CLI
// process cannot inspect connections held by an interactive conversation.
func runLocalSSHCommand(ctx context.Context, service *operate.Service, prompt string, out io.Writer, progress *terminalProgress) (bool, error) {
	args := strings.Fields(prompt)
	if len(args) == 0 {
		return false, nil
	}
	if args[0] != "/sessions" && args[0] != "/ssh" {
		return false, nil
	}
	if service == nil {
		return true, errors.New("当前未选择湖；请先运行 lake use <湖名> 并重新进入对话")
	}
	if args[0] == "/sessions" || (len(args) == 2 && args[1] == "ls") {
		if len(args) != 1 && args[0] == "/sessions" {
			return true, errors.New("用法：/sessions")
		}
		return true, writeSSHSessions(out, service.ListSessions())
	}
	if len(args) != 3 {
		return true, errors.New("用法：/ssh open <资源名>、/ssh close <资源名>，或 /sessions")
	}
	switch args[1] {
	case "open":
		progress.Start("正在建立 SSH 连接")
		defer progress.Stop()
		status, err := service.OpenSession(ctx, args[2])
		if err != nil {
			return true, err
		}
		progress.Stop()
		_, err = fmt.Fprintf(out, "已保持 SSH 连接：%s（%s）；输入 /sessions 查看。\n", status.Resource, status.SSH)
		return true, err
	case "close":
		if err := service.CloseSession(ctx, args[2]); err != nil {
			return true, err
		}
		_, err := fmt.Fprintf(out, "已关闭 SSH 连接：%s/%s\n", service.Lake.Name, args[2])
		return true, err
	default:
		return true, errors.New("用法：/ssh open <资源名>、/ssh close <资源名>，或 /sessions")
	}
}

func writeSSHSessions(out io.Writer, sessions []operate.SSHSessionStatus) error {
	if len(sessions) == 0 {
		_, err := io.WriteString(out, "当前没有挂起的 SSH 连接。\n")
		return err
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "RESOURCE\tSSH\tSTATE\tOPENED\tLAST_USED"); err != nil {
		return err
	}
	for _, session := range sessions {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			session.Resource, session.SSH, session.State,
			session.OpenedAt.Local().Format(time.DateTime), session.LastUsedAt.Local().Format(time.DateTime)); err != nil {
			return err
		}
	}
	return w.Flush()
}
