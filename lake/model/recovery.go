package model

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/cloudwego/eino/schema"
)

const modelResponseAttempts = 2

func hasReasoningText(raw json.RawMessage) bool {
	var text string
	return json.Unmarshal(raw, &text) == nil && strings.TrimSpace(text) != ""
}

// EmptyResponseError contains classification only, never provider response
// text, hidden reasoning, request content or credentials.
type EmptyResponseError struct {
	StopReason    string
	ReasoningOnly bool
	Attempts      int
}

func (e *EmptyResponseError) Error() string {
	if e.StopReason == "refusal" || e.StopReason == "content_filter" {
		return "模型服务未提供可用回复（拒绝或内容限制），本轮请求和附件已保留"
	}
	if e.StopReason == "failed" || e.StopReason == "cancelled" || e.StopReason == "pause_turn" || e.StopReason == "unknown" {
		return "模型服务未完成可用回复，本轮请求和附件已保留；请稍后重试或切换模型"
	}
	reason := ""
	if e.ReasoningOnly && e.truncated() {
		reason = "（思考已耗尽输出额度）"
	}
	if e.Attempts >= modelResponseAttempts {
		return "模型服务连续返回空内容" + reason + "，已自动重试1次。本轮请求和附件已保留；请稍后重试或切换模型"
	}
	return "模型响应没有文本或工具调用" + reason
}

func emptyResponse(stop string, reasoningOnly bool) *EmptyResponseError {
	// Stop reasons come from an untrusted endpoint; do not echo arbitrary data.
	switch stop {
	case "", "end_turn", "stop", "tool_use", "tool_calls", "max_tokens", "length", "incomplete", "completed", "refusal", "content_filter", "failed", "cancelled", "pause_turn":
	default:
		stop = "unknown"
	}
	return &EmptyResponseError{StopReason: stop, ReasoningOnly: reasoningOnly, Attempts: 1}
}

func (e *EmptyResponseError) truncated() bool {
	return e.StopReason == "max_tokens" || e.StopReason == "length" || e.StopReason == "incomplete"
}

func retryableEmpty(err error) *EmptyResponseError {
	var empty *EmptyResponseError
	if !errors.As(err, &empty) {
		return nil
	}
	switch empty.StopReason {
	case "refusal", "content_filter", "failed", "cancelled", "pause_turn", "unknown":
		return nil
	}
	return empty
}

func attemptedError(err error, attempts int) error {
	var empty *EmptyResponseError
	if errors.As(err, &empty) {
		copy := *empty
		copy.Attempts = attempts
		return &copy
	}
	return err
}

// Only retry the model generation. The input still contains actual previous
// tool results; the Agent executor is never restarted or invoked here.
func generateWithRecovery(ctx context.Context, call func(*EmptyResponseError) (*schema.Message, error)) (*schema.Message, error) {
	var previous *EmptyResponseError
	for attempt := 1; attempt <= modelResponseAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		answer, err := call(previous)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil {
			return answer, nil
		}
		previous = retryableEmpty(err)
		if previous == nil || attempt == modelResponseAttempts {
			return nil, attemptedError(err, attempt)
		}
	}
	panic("unreachable model recovery")
}

// Buffer metadata/whitespace until usable output arrives. Retry only when
// nothing has been published; partial text or tool calls cannot be replayed.
func streamWithRecovery(ctx context.Context, call func(*EmptyResponseError) (*schema.StreamReader[*schema.Message], error)) (*schema.StreamReader[*schema.Message], error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stream, err := call(nil)
	if ctx.Err() != nil {
		if stream != nil {
			stream.Close()
		}
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	reader, writer := schema.Pipe[*schema.Message](2)
	go func() {
		defer writer.Close()
		published := false
		for attempt := 1; attempt <= modelResponseAttempts; attempt++ {
			var pending []*schema.Message
			for {
				chunk, recvErr := stream.Recv()
				if ctx.Err() != nil {
					stream.Close()
					writer.Send(nil, ctx.Err())
					return
				}
				if recvErr != nil {
					stream.Close()
					if recvErr == io.EOF && published {
						return
					}
					if recvErr == io.EOF {
						recvErr = emptyResponse("", false)
					}
					previous := retryableEmpty(recvErr)
					if published || previous == nil || attempt == modelResponseAttempts {
						writer.Send(nil, attemptedError(recvErr, attempt))
						return
					}
					stream, err = call(previous)
					if ctx.Err() != nil {
						if stream != nil {
							stream.Close()
						}
						writer.Send(nil, ctx.Err())
						return
					}
					if err != nil {
						writer.Send(nil, err)
						return
					}
					break
				}
				if chunk == nil {
					continue
				}
				usable := strings.TrimSpace(chunk.Content) != "" || len(chunk.ToolCalls) != 0
				if !published && !usable {
					pending = append(pending, chunk)
					continue
				}
				for _, buffered := range pending {
					if writer.Send(buffered, nil) {
						stream.Close()
						return
					}
				}
				pending = nil
				published = true
				if writer.Send(chunk, nil) {
					stream.Close()
					return
				}
			}
		}
	}()
	return reader, nil
}
