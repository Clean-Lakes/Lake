package ai

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/extensions"
	"os"
	"path/filepath"
	"strings"
)

type Todo struct {
	Content  string `json:"content"`
	Status   string `json:"status"`
	Priority string `json:"priority,omitempty"`
}
type UserQuestion struct {
	ID          string           `json:"id"`
	Title       string           `json:"title"`
	Reason      string           `json:"reason,omitempty"`
	Options     []QuestionOption `json:"options,omitempty"`
	MultiSelect bool             `json:"multi_select,omitempty"`
}
type QuestionRequest struct {
	Answers          map[string][]string `json:"answers,omitempty"`
	Call             *Call               `json:"call,omitempty"`
	RuntimeSessionID string              `json:"runtimeSessionId,omitempty"`
	ID               string              `json:"id"`
	Questions        []UserQuestion      `json:"questions"`
}

func (e *Engine) invokeSessionTool(ctx context.Context, s *session, c Config, call Call, a map[string]any) (result any, err error) {
	cardID := uid()
	s.mu.Lock()
	id := s.state.View.Session
	foundCard := false
	for i := range s.state.View.Cards {
		card := &s.state.View.Cards[i]
		if card.Type == "operation" && str(obj(card.Data)["call_id"]) == call.ID && card.Status == "pending" {
			cardID = card.ID
			card.Status = "running"
			foundCard = true
			break
		}
	}
	if !foundCard {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: cardID, Type: "operation", Title: call.Name, Data: map[string]any{"arguments": a, "target": "当前项目/会话", "call_id": call.ID}, Status: "running", At: timestamp()})
	}
	e.notify(s, "toolCall", map[string]any{"name": call.Name})
	s.mu.Unlock()
	defer func() {
		if errors.Is(err, errADKApprovalPending) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for i := range s.state.View.Cards {
			card := &s.state.View.Cards[i]
			if card.ID == cardID {
				card.Status = "completed"
				card.Content = utf8Prefix(redact(js(result), c), 32000)
				if err != nil {
					card.Status = "failed"
					card.Content = redact(err.Error(), c)
				}
			}
		}
		if saveErr := e.save(s); err == nil && saveErr != nil {
			err = saveErr
		}
		e.notify(s, "operation", map[string]any{"card_id": cardID})
	}()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	switch call.Name {
	case "list_mcp_servers", "list_mcp_tools", "call_mcp_tool":
		if e.Bridge == nil {
			return nil, errors.New("MCP 需要 Lake 工作台")
		}
		approved := false
		bridgeArgs := map[string]any{}
		for k, v := range a {
			bridgeArgs[k] = v
		}
		if call.Name != "list_mcp_servers" {
			server, lookupErr := extensions.NewStore(skillHome(c)).FindServer(str(a["server_id"]))
			if lookupErr != nil {
				return nil, lookupErr
			}
			bridgeArgs["configurationRevision"] = extensions.ServerRevision(server)
			if !server.Enabled {
				return nil, errors.New("MCP 服务已停用")
			}
			if server.Transport == "stdio" && c.Permissions != nil && c.Permissions.DenyLocalExecution {
				return nil, errors.New("当前会话禁止启动本机 MCP")
			}
			if call.Name == "call_mcp_tool" || server.Transport == "stdio" {
				if c.Permissions != nil && c.Permissions.BlockUnreferencedAssets {
					return nil, errors.New("MCP 无法验证项目资源范围；当前会话仅允许操作已引用资源")
				}
				if c.Permissions == nil || !c.Permissions.SilentCommands {
					target := server.Name + " · " + str(a["tool"])
					if call.Name == "list_mcp_tools" {
						target = server.Name + " · 启动本机服务并读取工具"
					}
					if err = e.sessionApprovalTarget(ctx, s, call, "mcp", target); err != nil {
						return nil, err
					}
				}
				approved = true
			}
		}

		if e.worker != nil {
			c, err = e.scopedChildConfig(c, a)
			if err != nil {
				return nil, err
			}
			if call.Name != "list_mcp_servers" {
				server, lookupErr := extensions.NewStore(skillHome(c)).FindServer(str(a["server_id"]))
				if lookupErr != nil || !server.Enabled {
					return nil, errors.New("MCP 服务已不可用")
				}
				if c.Permissions != nil && (server.Transport == "stdio" && c.Permissions.DenyLocalExecution || (call.Name == "call_mcp_tool" || server.Transport == "stdio") && c.Permissions.BlockUnreferencedAssets) {
					return nil, errors.New("当前父会话权限已禁止此次 MCP 操作")
				}
			}
		}
		if err = e.DispatchSREOperation(ctx, c, call); err != nil {
			return nil, err
		}
		defer func() { e.finishSREOperation(c, call, result, err) }()
		operation, operationErr := e.dispatchNativeOperation(ctx, s, c, call, "write", serverTarget(a), hash(js(bridgeArgs)))
		if operationErr != nil {
			return nil, &ToolNotExecutedError{Err: operationErr}
		}
		defer func() {
			if persistErr := e.finishNativeOperation(operation, c, result, err); persistErr != nil {
				err = persistErr
			}
		}()
		return e.bridgeCall(ctx, id, call.Name, bridgeArgs, approved)

	case "todo_read":
		s.mu.Lock()
		defer s.mu.Unlock()
		return map[string]any{"todos": append([]Todo{}, s.state.View.Todos...)}, nil
	case "todo_write":
		var input struct {
			Todos []Todo `json:"todos"`
		}
		if json.Unmarshal([]byte(call.Arguments), &input) != nil || len(input.Todos) > 100 {
			return nil, errors.New("invalid todo list")
		}
		for _, t := range input.Todos {
			if strings.TrimSpace(t.Content) == "" || len(t.Content) > 2000 || !strings.Contains(" pending in_progress completed ", " "+t.Status+" ") || t.Priority != "" && !strings.Contains(" high medium low ", " "+t.Priority+" ") {
				return nil, errors.New("invalid todo item")
			}
		}
		s.mu.Lock()
		s.state.View.Todos = input.Todos
		err = e.save(s)
		e.notify(s, "todos", input.Todos)
		s.mu.Unlock()
		return map[string]any{"todos": input.Todos}, err
	case "ask_user_question":
		return e.askQuestion(ctx, s, call)
	case "read_tool_result":
		return e.readToolResult(id, a)
	case "load_skill":
		if c.Permissions != nil && c.Permissions.DenyLocalExecution {
			return nil, errors.New("当前会话禁止读取本机技能文件")
		}
		if c.Permissions != nil && !c.Permissions.SilentReadFiles {
			if err = e.sessionApproval(ctx, s, call, "file_read"); err != nil {
				return nil, err
			}
		}
		return e.loadSkill(c, str(a["name"]))
	case "task_output", "task_stop":
		return e.taskTool(ctx, s, c, call, a)
	}
	if e.Bridge == nil {
		return nil, errors.New("此工具需要 Lake 工作台")
	}
	mutation := call.Name == "run_workflow" || call.Name == "save_workflow" || strings.HasPrefix(call.Name, "schedule_") && call.Name != "schedule_list"
	if mutation {
		silent := c.Permissions != nil && c.Permissions.SilentWriteFiles
		if call.Name == "run_workflow" {
			silent = c.Permissions != nil && c.Permissions.SilentCommands
		}
		if !silent {
			if err = e.sessionApproval(ctx, s, call, "project_operation"); err != nil {
				return nil, err
			}
		}
	}
	if mutation {
		operation, operationErr := e.dispatchNativeOperation(ctx, s, c, call, "write", "当前项目", hash(call.Arguments))
		if operationErr != nil {
			return nil, &ToolNotExecutedError{Err: operationErr}
		}
		defer func() {
			if persistErr := e.finishNativeOperation(operation, c, result, err); persistErr != nil {
				err = persistErr
			}
		}()
	}
	return e.bridgeCall(ctx, id, call.Name, a, mutation)
}
func serverTarget(a map[string]any) string { return "MCP · " + str(a["server_id"]) }

func (e *Engine) sessionApproval(ctx context.Context, s *session, call Call, kind string) error {
	return e.sessionApprovalTarget(ctx, s, call, kind, "当前项目")
}
func (e *Engine) sessionApprovalTarget(ctx context.Context, s *session, call Call, kind, target string) error {
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	p := &Approval{ID: uid(), Call: call, Target: target, Risk: "write", Kind: kind, Fingerprint: hash(call.Arguments)}
	_, err := e.waitNativeApproval(ctx, s, c, p)
	return err
}

func (e *Engine) askQuestion(ctx context.Context, s *session, call Call) (any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var input struct {
		Questions []UserQuestion `json:"questions"`
	}
	if json.Unmarshal([]byte(call.Arguments), &input) != nil || len(input.Questions) < 1 || len(input.Questions) > 3 {
		return nil, errors.New("questions must contain 1..3 items")
	}
	seen := map[string]bool{}
	for _, q := range input.Questions {
		if !identifier.MatchString(q.ID) || seen[q.ID] || strings.TrimSpace(q.Title) == "" || len(q.Title) > 2000 || len(q.Reason) > 2000 || len(q.Options) > 8 {
			return nil, errors.New("invalid question")
		}
		seen[q.ID] = true
		opts := map[string]bool{}
		for _, o := range q.Options {
			if strings.TrimSpace(o.Label) == "" || len(o.Label) > 1000 || len(o.Description) > 2000 || opts[o.Label] {
				return nil, errors.New("invalid question option")
			}
			opts[o.Label] = true
		}
	}
	s.mu.Lock()
	key := hash(s.state.View.RootTurnID + js(input.Questions))
	previous, reused := s.state.QuestionDecisions[key]
	s.mu.Unlock()
	if reused {
		return questionResult(input.Questions, previous, true), nil
	}
	req := &QuestionRequest{ID: uid(), Questions: input.Questions}
	s.mu.Lock()
	questionConfig := s.state.Config
	s.mu.Unlock()
	if ctx.Value(adkToolContextKey{}) != nil {
		req.Call = &call
		req.RuntimeSessionID = "input_" + uid()
		if err := e.runNativeQuestion(ctx, req, nil, questionConfig); err != nil {
			return nil, err
		}
	}
	reply := make(chan map[string][]string, 1)
	s.mu.Lock()
	s.questionReply = reply
	s.state.View.Question = req
	err := e.saveHumanInputState(s)
	e.notify(s, "question", req)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.questionReply = nil
		s.state.View.Question = nil
		_ = e.saveHumanInputState(s)
		e.notify(s, "question", nil)
		s.mu.Unlock()
	}()
	if err != nil {
		return nil, err
	}
	select {
	case answers := <-reply:
		if req.RuntimeSessionID != "" {
			if err := e.runNativeQuestion(ctx, req, answers, questionConfig); err != nil {
				return nil, err
			}
		}
		s.mu.Lock()
		if s.state.QuestionDecisions == nil {
			s.state.QuestionDecisions = map[string]map[string][]string{}
		}
		s.state.QuestionDecisions[key] = answers
		saveErr := e.save(s)
		s.mu.Unlock()
		return questionResult(req.Questions, answers, false), saveErr
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (e *Engine) ReplyQuestion(id, requestID string, answers map[string][]string) error {
	return e.ReplyQuestionWithTarget(id, requestID, answers, nil)
}

// ReplyQuestionWithTarget accepts a target resolved by the trusted application
// from the actual human answer. Question text and model-proposed options cannot
// select resources before that answer is validated and submitted.
func (e *Engine) ReplyQuestionWithTarget(id, requestID string, answers map[string][]string, scope *TargetScope) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	req := s.state.View.Question
	if req == nil || req.ID != requestID || s.questionReply == nil && (!nativeQuestionReady(req) || s.cancel != nil) {
		return errors.New("question expired")
	}
	if err := validateQuestionAnswers(req, answers); err != nil {
		return err
	}
	if scope != nil {
		for _, ref := range scope.ResourceIDs {
			as, err := asset(s.state.Config, ref)
			if err != nil || as.ID != ref {
				return errors.New("question target contains an unavailable resource")
			}
		}
		previous := s.state.TargetScope
		previousRefs := s.state.ReferencedAssetIDs
		s.state.TargetScope = cloneTargetScope(scope)
		s.state.ReferencedAssetIDs = validRemembered(s.state.Config, append(append([]string{}, previousRefs...), scope.ResourceIDs...))
		if err := e.save(s); err != nil {
			s.state.TargetScope = previous
			s.state.ReferencedAssetIDs = previousRefs
			return err
		}
	}
	if s.questionReply == nil {
		return e.recoverQuestionReply(s, req, answers)
	}
	select {
	case s.questionReply <- answers:
		s.questionReply = nil
		return nil
	default:
		return errors.New("question already answered")
	}
}

func questionResult(questions []UserQuestion, answers map[string][]string, reused bool) map[string]any {
	skipped := []string{}
	for _, q := range questions {
		if len(answers[q.ID]) == 0 {
			skipped = append(skipped, q.ID)
		}
	}
	return map[string]any{"questions": questions, "answers": answers, "skipped": skipped, "reused": reused, "notice": "Answers select requirements only and do not authorize operations. Skipped questions are unanswered, not rejection. Continue independent useful work with sensible defaults; do not repeat unchanged skipped questions or guess a required target."}
}

func skillHome(c Config) string {
	if c.CredentialDir != "" {
		return filepath.Dir(c.CredentialDir)
	}
	if home := os.Getenv("LAKE_HOME"); home != "" {
		return home
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".lake")
}

// Unconfigured integrations must not consume the model's tool/context budget.
func (e *Engine) configuredExtensionTools(c Config, list []Tool) []Tool {
	enabled := false
	if e.Bridge != nil {
		if catalog, err := extensions.NewStore(skillHome(c)).Read(); err == nil {
			for _, server := range catalog.Servers {
				if server.Enabled {
					enabled = true
					break
				}
			}
		}
	}
	if enabled {
		return list
	}
	out := make([]Tool, 0, len(list))
	for _, tool := range list {
		if tool.Name != "list_mcp_servers" && tool.Name != "list_mcp_tools" && tool.Name != "call_mcp_tool" {
			out = append(out, tool)
		}
	}
	return out
}

func validateQuestionAnswers(req *QuestionRequest, answers map[string][]string) error {
	allowed := map[string]UserQuestion{}
	for _, q := range req.Questions {
		allowed[q.ID] = q
	}
	for key, values := range answers {
		q, ok := allowed[key]
		if !ok || len(values) > 9 || !q.MultiSelect && len(values) > 1 {
			return errors.New("invalid question answers")
		}
		for _, v := range values {
			if len(v) > 4000 {
				return errors.New("answer too long")
			}
		}
	}

	return nil
}
