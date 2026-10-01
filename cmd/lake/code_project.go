package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/store"
)

func codeProjectCommand(ctx context.Context, s *store.Store, args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake code 需要 add/list/bind 命令")
	}
	switch args[0] {
	case "remote":
		return codeRemoteCommand(ctx, s, args[1:], in, out, errOut)
	case "add":
		if len(args) < 3 {
			return errors.New("用法：lake code add <湖名> <项目名> --path <目录>")
		}
		f := flags("lake code add", errOut)
		path := f.String("path", "", "本地目录")
		_ = f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[3:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("lake code add 参数过多")
		}
		if _, err := code.Open(*path); err != nil {
			return err
		}
		project, err := s.CreateCodeProject(ctx, args[1], args[2], *path)
		if err != nil {
			return err
		}
		return writeJSON(out, project)
	case "list":
		if len(args) > 2 || len(args) == 2 && args[1] != "--json" {
			return errors.New("lake code list 参数过多")
		}
		projects, err := s.ListCodeProjects(ctx)
		if err != nil {
			return err
		}
		return writeJSON(out, projects)
	case "bind":
		if len(args) < 3 || len(args) > 4 || len(args) == 4 && args[3] != "--json" {
			return errors.New("用法：lake code bind <会话ID> <项目ID|none>")
		}
		projectID := args[2]
		if strings.EqualFold(projectID, "none") {
			projectID = ""
		}
		conversation, err := s.SetConversationProject(ctx, args[1], projectID)
		if err != nil {
			return fmt.Errorf("绑定代码项目: %w", err)
		}
		return writeJSON(out, conversation)
	default:
		return fmt.Errorf("未知代码项目命令 %q", args[0])
	}
}
