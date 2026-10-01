package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/store"
)

func conversationCommand(ctx context.Context, s *store.Store, args []string, out, _ io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake conversation 需要 list/archived/create/show/rename/archive/restore")
	}
	command := args[0]
	var positional []string
	for _, arg := range args[1:] {
		if arg == "--json" {
			continue
		}
		if strings.HasPrefix(arg, "-") {
			return fmt.Errorf("未知参数 %q", arg)
		}
		positional = append(positional, arg)
	}
	switch command {
	case "list":
		if len(positional) != 0 {
			return errors.New("list 不接受额外参数")
		}
		items, err := s.ListConversations(ctx)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "archived":
		if len(positional) != 0 {
			return errors.New("archived 不接受额外参数")
		}
		items, err := s.ListArchivedConversations(ctx)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "create":
		if len(positional) != 1 {
			return errors.New("create 需要湖名")
		}
		item, err := s.CreateConversation(ctx, positional[0])
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "show":
		if len(positional) != 1 {
			return errors.New("show 需要会话 ID")
		}
		item, err := s.GetConversation(ctx, positional[0])
		if err != nil {
			return err
		}
		turns, err := s.ListConversationTurns(ctx, item.ID)
		if err != nil {
			return err
		}
		var events []store.ConversationEvent
		var cursor uint64
		for {
			page, err := s.ListAgentEvents(ctx, item.ID, cursor, 500)
			if err != nil {
				return err
			}
			events = append(events, page...)
			if len(page) < 500 {
				break
			}
			cursor = page[len(page)-1].Sequence
		}
		return writeJSON(out, map[string]any{"conversation": item, "turns": turns, "events": events})
	case "rename":
		if len(positional) < 2 {
			return errors.New("rename 需要会话 ID 和标题")
		}
		item, err := s.RenameConversation(ctx, positional[0], strings.Join(positional[1:], " "))
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "archive":
		if len(positional) != 1 {
			return errors.New("archive 需要会话 ID")
		}
		if err := s.ArchiveConversation(ctx, positional[0]); err != nil {
			return err
		}
		return writeJSON(out, map[string]any{"id": positional[0], "archived": true})
	case "restore":
		if len(positional) != 1 {
			return errors.New("restore 需要会话 ID")
		}
		if err := s.RestoreConversation(ctx, positional[0]); err != nil {
			return err
		}
		return writeJSON(out, map[string]any{"id": positional[0], "archived": false})
	default:
		return fmt.Errorf("未知会话命令 %q", command)
	}
}
