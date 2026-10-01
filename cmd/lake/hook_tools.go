package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/cloudwego/eino/components/tool"
	lakehooks "github.com/cloudwego/eino/lake/extension/hooks"
	"github.com/cloudwego/eino/schema"
)

type hookedTool struct {
	original tool.InvokableTool
	emit     func(context.Context, lakehooks.Event, map[string]string)
}

func (t hookedTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	return t.original.Info(ctx)
}

func (t hookedTool) InvokableRun(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
	info, err := t.original.Info(ctx)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(arguments))
	meta := map[string]string{"tool": info.Name, "sha256": hex.EncodeToString(digest[:])}
	if t.emit != nil {
		t.emit(ctx, lakehooks.PreToolUse, meta)
	}
	result, err := t.original.InvokableRun(ctx, arguments, opts...)
	if t.emit != nil {
		if err != nil {
			t.emit(ctx, lakehooks.PostToolUseFailure, map[string]string{"tool": info.Name, "sha256": meta["sha256"], "status": "failed"})
		} else {
			t.emit(ctx, lakehooks.PostToolUse, map[string]string{"tool": info.Name, "sha256": meta["sha256"], "status": "completed"})
		}
	}
	return result, err
}
