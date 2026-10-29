package ai

import (
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
	"strings"
)

// Only terminal full responses are corrected. Streaming fragments remain
// progress; host-generated control calls are readonly and explicitly sourced.
func (d *adkTurnDriver) workDecision(_ agent.Context, response *model.LLMResponse, modelErr error) (*model.LLMResponse, error) {
	if modelErr != nil || response == nil || response.Partial || response.Content == nil || d.config.sreCoordinator || d.config.sre != nil || d.engine.worker != nil {
		return nil, nil
	}
	var functionCalls []*genai.FunctionCall
	for _, part := range response.Content.Parts {
		if part.FunctionCall != nil {
			functionCalls = append(functionCalls, part.FunctionCall)
		}
	}
	s := d.session
	s.mu.Lock()
	id, goalID := s.state.View.Session, s.state.WorkGoalID
	s.mu.Unlock()
	if goalID == "" {
		return nil, nil
	}
	row, g, err := d.engine.workRow(id, goalID)
	if err != nil {
		return nil, err
	}
	if workTerminal(g.Status) || g.Status == "paused" || g.Status == "waiting_user" || g.Status == "blocked" {
		return nil, nil
	}
	if len(functionCalls) > 0 {
		if len(functionCalls) == 1 {
			call := functionCalls[0]
			if call.Name == "wait_shell" || call.Name == "shell_output" {
				if call.Name == "shell_output" {
					if d.workOutputPolls == nil {
						d.workOutputPolls = map[string]int{}
					}
					key := str(call.Args["shell_id"])
					d.workOutputPolls[key]++
					if d.workOutputPolls[key] < 3 {
						return nil, nil
					}
				}

				for _, item := range g.Items {
					if item.Watch != nil && item.Status == "waiting_external" && (item.Watch.Handle == str(call.Args["shell_id"]) || item.Watch.OperationID == str(call.Args["shell_id"])) {
						s.mu.Lock()
						for i := len(s.state.History) - 1; i >= 0; i-- {
							m := &s.state.History[i]
							if m.Role == "assistant" && len(m.Calls) == 1 && m.Calls[0].ID == call.ID {
								m.Calls[0].Name = "work_wait"
								m.Calls[0].Arguments = "{}"
								m.Native = nil
								m.NativeModel = ""
								m.NativeProtocol = ""
								m.Content += "\n[Host: persistently wait for this original background job instead of model polling; no operation approval.]"
								break
							}
						}
						err = d.engine.save(s)
						s.mu.Unlock()
						if err != nil {
							return nil, err
						}
						return &model.LLMResponse{Content: &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: call.ID, Name: "work_wait", Args: map[string]any{}}}}}}, nil
					}
				}
			}
		}
		return nil, nil
	}
	external, runnable := false, false
	for _, item := range g.Items {
		if item.Status == "waiting_external" {
			external = true
		}
		if item.Status == "pending" || item.Status == "running" {
			runnable = runnable || workItemReady(g.Items, item)
		}
	}
	if !external && !runnable {
		state := reduceWorkGoal(g.Items)
		var text strings.Builder
		for _, part := range response.Content.Parts {
			if !part.Thought {
				text.WriteString(part.Text)
			}
		}
		if state == "waiting_user" || state == "blocked" {
			g.Status = state
			g.Summary = redact(utf8Prefix(text.String(), 8000), *d.config)
			g.BackgroundSummary = d.engine.workParent != nil
			return nil, d.engine.writeWorkGoal(&row, &g, false)
		}
		if len(g.Items) > 0 && (state == "completed" || state == "failed") {
			g.Status = state
			g.Summary = redact(utf8Prefix(text.String(), 8000), *d.config)
			g.BackgroundSummary = d.engine.workParent != nil
			return nil, d.engine.writeWorkGoal(&row, &g, false)
		}
	}
	name := "work_read"
	if external && !runnable {
		name = "work_wait"
	} else {
		if d.workRepairs >= 2 {
			g.Status = "paused"
			g.Summary = "模型未提交可执行的下一步，已保留任务进度"
			return nil, d.engine.writeWorkGoal(&row, &g, false)
		}
		d.workRepairs++
	}
	call := Call{ID: "host-work-" + uid(), Name: name, Arguments: "{}"}
	s.mu.Lock()
	s.state.History = append(s.state.History, Message{Role: "assistant", Content: "Host task checkpoint. This readonly control call is not user authorization.", Calls: []Call{call}})
	err = d.engine.save(s)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &model.LLMResponse{Content: &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: call.ID, Name: name, Args: map[string]any{}}}}}}, nil
}
