package main

import (
	"context"
	"github.com/cloudwego/eino/lake/store"
)

type specialistExecution struct {
	CommandRunner  func(context.Context, string, string, string) (store.ExecutionRecord, error)
	Root           string
	LakeID         string
	SessionID      string
	ConversationID string
	ModelID        string
	Store          *store.Store
}
