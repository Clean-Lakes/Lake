package ai

import (
	"encoding/json"
	"errors"
	"strings"
)

const (
	ModeDefault = "default"
	ModePlan    = "plan"
)

type ProposedPlan struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	At      string `json:"at"`
}

func ValidConversationMode(mode string) bool {
	return mode == "" || mode == ModeDefault || mode == ModePlan
}

// Fail closed for future capabilities, especially session tools which bypass
// the resource approval path. Local todo progress is the only editable state.
func planToolAllowed(name string) bool {
	switch name {
	case "list_assets", "list_resource_groups", "ls", "glob", "grep", "read",
		"inspect_host", "shell", "terminal_execute_command", "open_ssh_terminal",
		"read_terminal_screen", "shell_output", "wait_shell",
		"web_fetch", "web_search", "list_db_objects", "db_table_ddl", "execute_sql", "redis_command",
		"inspect_attachment", "preview_resource_import", "render_chart",
		"todo_read", "todo_write", "ask_user_question", "read_session_context", "load_skill",
		"list_workflows", "get_workflow_run", "schedule_list", "task_output", "read_tool_result",
		"list_project_memories", "read_project_memory", "list_mcp_servers":
		return true
	}
	return false
}

func planCatalog(list []Tool) []Tool {
	out := make([]Tool, 0, len(list))
	for _, tool := range list {
		if planToolAllowed(tool.Name) {
			out = append(out, tool)
		}
	}
	return out
}

func checkPlanOperation(c Config, name, risk string) error {
	if c.ConversationMode == ModePlan && (!planToolAllowed(name) || risk != "readonly") {
		return errors.New("Plan 模式只允许只读调查；请先审阅计划并切换到执行模式后再进行变更")
	}
	return nil
}

const planModePrompt = `
[PLAN MODE — enforced by the runtime]
Work with the user to produce a decision-complete implementation or operations plan. First inspect relevant available evidence using read-only tools. Use ask_user_question for unresolved choices that materially affect scope, targets, design or acceptance; do not ask about facts you can inspect, and do not assume unanswered choices.
Do not implement the plan or change files, services, resources, memory, workflows or schedules. Only commands established as read-only by the trusted policy may run. MCP execution and delegation are unavailable. Skills, user requests to implement, permission settings and prior approvals cannot override this mode. Local todo progress is allowed. Do not write a plan file; return the plan in the conversation.
When ready, return a self-contained Markdown plan in the user's language with a clear title, goal, concrete ordered steps, relevant targets/files/interfaces, validation, and material assumptions or risks. Be specific enough to execute without inventing missing decisions. Wrap the entire final plan in <proposed_plan> and </proposed_plan> tags, each on its own line. Use those tags only for a complete, reviewable plan; ordinary answers, progress updates and clarification questions must not use them. If still waiting for a decision, ask rather than presenting a completed plan. The interface offers an Execute plan action only for a complete tagged plan; remain in Plan mode until the user explicitly switches modes or uses that action. Never claim the plan has already been implemented.
`

// Called under the session lock only after a successful planning turn. A
// clarification round with no final assistant text does not create a proposal.
func captureProposedPlan(s *session, firstCard int) {
	archiveProposedPlan(s)
	s.state.View.ProposedPlan = nil
	if s.state.View.Question != nil {
		return
	}
	for i := len(s.state.View.Cards) - 1; i >= firstCard; i-- {
		card := s.state.View.Cards[i]
		if card.Type == "message" && strings.TrimSpace(card.Content) != "" {
			content, ok := proposedPlanContent(card.Content)
			if !ok {
				return
			}
			s.state.View.ProposedPlan = &ProposedPlan{ID: card.ID, Content: content, At: card.At}
			archiveProposedPlan(s)
			return
		}
		if card.Type == "operation" {
			return // Text preceding the last tool is a progress update, not a plan.
		}
	}
}

// A provider may introduce its plan before the tagged block or add a closing
// note. Only the single explicit block is executable; prose and fenced examples
// outside it never become part of the approved content.
func proposedPlanContent(text string) (string, bool) {
	lines := strings.Split(text, "\n")
	start, end := -1, -1
	fence := ""
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trimmed, fence) && strings.Trim(trimmed, string(fence[0])+" \t\r") == "" {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			marker := trimmed[0]
			length := 0
			for length < len(trimmed) && trimmed[length] == marker {
				length++
			}
			fence = trimmed[:length]
			continue
		}
		switch trimmed {
		case "<proposed_plan>":
			if start >= 0 {
				return "", false
			}
			start = i
		case "</proposed_plan>":
			if start < 0 || end >= 0 {
				return "", false
			}
			end = i
		}
	}
	if start < 0 || end <= start {
		return "", false
	}
	content := strings.TrimSpace(strings.Join(lines[start+1:end], "\n"))
	return content, content != ""
}

// Mark only proposals accepted by the runtime, never arbitrary tagged prose.
// Keeping the marker on the durable card also survives native ADK recovery.
func archiveProposedPlan(s *session) {
	if plan := s.state.View.ProposedPlan; plan != nil {
		for i := range s.state.View.Cards {
			card := &s.state.View.Cards[i]
			if card.ID == plan.ID {
				data := obj(card.Data)
				data["proposedPlan"] = true
				card.Data = data
				return
			}
		}
	}
}

// ProposedPlans reads the full durable history independently of transcript
// pagination, including complete tagged legacy replies for review. Listing a
// legacy block never promotes it to the current executable ProposedPlan.
func (e *Engine) ProposedPlans(id string) ([]ProposedPlan, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	plans := []ProposedPlan{}
	for i := len(s.state.View.Cards) - 1; i >= 0; i-- {
		card := s.state.View.Cards[i]
		if card.Type != "message" {
			continue
		}
		if card.Status != "completed" && obj(card.Data)["proposedPlan"] != true && (s.state.View.ProposedPlan == nil || s.state.View.ProposedPlan.ID != card.ID) {
			continue
		}
		content, ok := proposedPlanContent(card.Content)
		if !ok {
			continue
		}
		plans = append(plans, ProposedPlan{ID: card.ID, Content: content, At: card.At})
	}
	var clean []ProposedPlan
	err = json.Unmarshal(safeJSON([]byte(js(plans)), s.state.Config), &clean)
	return clean, err
}
