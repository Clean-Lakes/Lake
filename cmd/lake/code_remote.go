package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cloudwego/eino/lake/code/remote"
	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/term"
)

func codeRemoteCommand(ctx context.Context, data *store.Store, args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake code remote add|list|authz|bind|files|read|write|run")
	}
	service := remote.Service{Store: data}
	if file, ok := in.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		scanner := bufio.NewScanner(in)
		service.Approve = func(kind, target, detail string) (bool, error) {
			_, _ = fmt.Fprintf(errOut, "远程代码操作 %s\n目标: %s\n%s\n输入 yes 批准本次操作：", kind, target, detail)
			if !scanner.Scan() {
				return false, scanner.Err()
			}
			return strings.TrimSpace(scanner.Text()) == "yes", nil
		}
	}
	switch args[0] {
	case "add":
		if len(args) < 3 {
			return errors.New("用法：lake code remote add <湖名> <名称> --resource 湖/主机 --root /目录")
		}
		f := flags("lake code remote add", errOut)
		resource := f.String("resource", "", "湖/SSH 主机")
		root := f.String("root", "", "远端规范绝对路径")
		_ = f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[3:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *resource == "" || *root == "" {
			return errors.New("远程工作区需要 --resource 和 --root")
		}
		item, err := service.Register(ctx, args[1], *resource, args[2], *root)
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "list":
		f := flags("lake code remote list", errOut)
		lakeName := f.String("lake", "", "湖名")
		_ = f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("lake code remote list 参数过多")
		}
		lakeID := ""
		if *lakeName != "" {
			lake, err := data.GetLakeByName(ctx, *lakeName)
			if err != nil {
				return err
			}
			lakeID = lake.ID
		}
		items, err := data.ListCodeWorkspaces(ctx, lakeID)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "authz":
		if len(args) < 3 || len(args) > 4 || len(args) == 4 && args[3] != "--json" {
			return errors.New("用法：lake code remote authz <工作区ID> on|off")
		}
		if args[2] != "on" && args[2] != "off" {
			return errors.New("授权值须为 on 或 off")
		}
		item, err := data.SetCodeWorkspaceAuthorized(ctx, args[1], args[2] == "on")
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "bind":
		if len(args) < 3 || len(args) > 4 || len(args) == 4 && args[3] != "--json" {
			return errors.New("用法：lake code remote bind <会话ID> <工作区ID|none>")
		}
		id := args[2]
		if strings.EqualFold(id, "none") {
			id = ""
		}
		item, err := data.SetConversationCodeWorkspace(ctx, args[1], id)
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "files":
		if len(args) < 2 || len(args) > 3 || len(args) == 3 && args[2] != "--json" {
			return errors.New("用法：lake code remote files <工作区ID>")
		}
		items, err := service.List(ctx, args[1])
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "read":
		if len(args) < 3 || len(args) > 4 || len(args) == 4 && args[3] != "--json" {
			return errors.New("用法：lake code remote read <工作区ID> <相对路径>")
		}
		content, err := service.Read(ctx, args[1], args[2])
		if err != nil {
			return err
		}
		return writeJSON(out, content)
	case "run":
		if len(args) < 2 {
			return errors.New("用法：lake code remote run <工作区ID> --command <单行命令>")
		}
		f := flags("lake code remote run", errOut)
		command := f.String("command", "", "远端单行 Shell 命令")
		_ = f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[2:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *command == "" {
			return errors.New("需要 --command")
		}
		result, err := service.Run(ctx, args[1], *command)
		if err != nil {
			return err
		}
		return writeJSON(out, result)
	case "write":
		if len(args) < 3 {
			return errors.New("用法：lake code remote write <工作区ID> <相对路径> --file <本地文件> --expected-sha256 <摘要|absent>")
		}
		f := flags("lake code remote write", errOut)
		file := f.String("file", "", "要写入的本地文本文件")
		expected := f.String("expected-sha256", "", "远端原文件的 SHA-256，或 absent")
		_ = f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[3:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *file == "" || *expected == "" {
			return errors.New("需要 --file 和 --expected-sha256")
		}
		input, err := os.Open(*file)
		if err != nil {
			return err
		}
		defer input.Close()
		content, err := io.ReadAll(io.LimitReader(input, 65537))
		if err != nil {
			return err
		}
		defer clearBytes(content)
		if len(content) > 65536 {
			return errors.New("远程文件不得超过 64 KiB")
		}
		result, err := service.Write(ctx, args[1], args[2], *expected, content)
		if err != nil {
			return err
		}
		return writeJSON(out, result)
	default:
		return fmt.Errorf("未知远程代码命令 %q", args[0])
	}
}
