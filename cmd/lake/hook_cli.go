package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/extension/hooks"
	"github.com/cloudwego/eino/lake/store"
)

func hookCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] != "status" && args[0] != "enable" && args[0] != "disable" {
		return errors.New("用法：lake hook status|enable|disable -C <项目目录>")
	}
	mode := args[0]
	f := flags("lake hook "+mode, errOut)
	project := f.String("C", "", "代码项目目录")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil || f.NArg() != 0 || *project == "" {
		return errors.New("用法：lake hook status|enable|disable -C <项目目录> [--json]")
	}
	workspace, err := code.Open(*project)
	if err != nil {
		return err
	}
	if mode == "disable" {
		saved, err := s.GetWorkspaceHook(ctx, workspace.Root)
		if err != nil {
			return err
		}
		if _, err := s.SetWorkspaceHookEnabled(ctx, workspace.Root, saved.Digest, false); err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, "Hook 已关闭")
		return err
	}
	runner, err := hooks.Load(workspace.Root)
	if err != nil {
		return err
	}
	if mode == "enable" {
		if _, err := s.SaveWorkspaceHook(ctx, workspace.Root, runner.Digest); err != nil {
			return err
		}
		if _, err := s.SetWorkspaceHookEnabled(ctx, workspace.Root, runner.Digest, true); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "Hook 已启用（SHA-256: %s）\n", runner.Digest)
		return err
	}
	state := "disabled"
	saved, err := s.GetWorkspaceHook(ctx, workspace.Root)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil {
		if saved.Digest != runner.Digest {
			state = "changed"
		} else if saved.Enabled {
			state = "enabled"
		}
	}
	if *asJSON {
		return json.NewEncoder(out).Encode(map[string]any{"workspace": workspace.Root, "status": state, "sha256": runner.Digest, "hooks": len(runner.Manifest.Hooks)})
	}
	_, err = fmt.Fprintf(out, "%s\t%s\t%d hooks\n", state, runner.Digest, len(runner.Manifest.Hooks))
	return err
}
