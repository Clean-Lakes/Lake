package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/cloudwego/eino/lake/store"
)

func permissionsCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) != 0 && args[0] == "set" {
		if len(args) < 3 {
			return errors.New("用法：lake permissions set ssh-read|ssh-command on|off [--json]")
		}
		key, value := args[1], args[2]
		if (key != "ssh-read" && key != "ssh-command") || (value != "on" && value != "off") {
			return errors.New("用法：lake permissions set ssh-read|ssh-command on|off [--json]")
		}
		f := flags("lake permissions set", errOut)
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[3:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("lake permissions set 参数过多")
		}
		actionID, err := store.NewActionID()
		if err != nil {
			return err
		}
		var policy store.PermissionPolicy
		if err := s.Mutate(ctx, func(m *store.Mutation) error {
			var err error
			policy, err = m.SetPermissionPolicy(ctx, key, value == "on")
			if err != nil {
				return err
			}
			_, err = m.AppendJournal(ctx, store.JournalInput{
				ActionID: actionID, Actor: "cli", TargetPath: "permissions/" + key,
				Tool: "lake.permissions", Risk: "none", Event: "completed", Detail: value,
			})
			return err
		}); err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, policy)
		}
		_, err = fmt.Fprintf(out, "%s=%s（持久生效）\n", key, value)
		return err
	}
	f := flags("lake permissions", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("用法：lake permissions [--json]")
	}
	policy, err := s.GetPermissionPolicy(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, policy)
	}
	_, err = fmt.Fprintf(out, "静默执行只读 SSH 检查：%t\n静默执行 SSH 命令：%t\n", policy.SilentSSHRead, policy.SilentSSHCommand)
	return err
}
