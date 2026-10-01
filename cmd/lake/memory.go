package main

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/store"
)

func memoryCommand(ctx context.Context, s *store.Store, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake memory 需要 show/on/off/edit/delete")
	}
	var positional []string
	for _, arg := range args {
		if arg != "--json" {
			positional = append(positional, arg)
		}
	}
	lake, err := s.CurrentLake(ctx)
	if err != nil {
		return err
	}
	switch positional[0] {
	case "show", "list":
		if len(positional) != 1 {
			return errors.New("show 不接受额外参数")
		}
	case "on", "off":
		if len(positional) != 1 {
			return errors.New("on/off 不接受额外参数")
		}
		if err := s.SetMemoryEnabled(ctx, lake.ID, positional[0] == "on"); err != nil {
			return err
		}
	case "delete":
		if len(positional) != 2 {
			return errors.New("delete 需要记忆 ID")
		}
		if err := s.DeleteMemoryFact(ctx, lake.ID, positional[1]); err != nil {
			return err
		}
	case "edit":
		if len(positional) < 3 {
			return errors.New("edit 需要记忆 ID 和新内容")
		}
		if err := s.EditMemoryFact(ctx, lake.ID, positional[1], strings.Join(positional[2:], " ")); err != nil {
			return err
		}
	default:
		return errors.New("未知记忆命令")
	}
	enabled, err := s.MemoryEnabled(ctx, lake.ID)
	if err != nil {
		return err
	}
	facts, err := s.ListAllMemoryFacts(ctx, lake.ID)
	if err != nil {
		return err
	}
	if facts == nil {
		facts = []store.MemoryFact{}
	}
	return writeJSON(out, map[string]any{"lake_id": lake.ID, "lake": lake.Name, "enabled": enabled, "facts": facts})
}
