package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/agent"
)

const maxAgentEventPayload = 64 * 1024

type AgentEventInput struct {
	Kind       string
	Actor      string
	ToolCallID string
	Payload    json.RawMessage
}

type ConversationEvent struct {
	ConversationID string          `json:"conversation_id"`
	Sequence       uint64          `json:"sequence"`
	Kind           string          `json:"kind"`
	Actor          string          `json:"actor"`
	ToolCallID     string          `json:"tool_call_id,omitempty"`
	LegacyTurnID   string          `json:"legacy_turn_id,omitempty"`
	Payload        json.RawMessage `json:"payload"`
	CreatedAt      time.Time       `json:"created_at"`
}

type ConversationSummaryInput struct {
	ThroughSeq     uint64
	Text           string
	SourceEventIDs []uint64
	TokenEstimate  int
	TaskState      *agent.TaskState
}

type ConversationSummary struct {
	ConversationID string           `json:"conversation_id"`
	ThroughSeq     uint64           `json:"through_seq"`
	Text           string           `json:"text"`
	SourceEventIDs []uint64         `json:"source_event_ids"`
	TokenEstimate  int              `json:"token_estimate"`
	CreatedAt      time.Time        `json:"created_at"`
	TaskState      *agent.TaskState `json:"task_state,omitempty"`
}

// Event payloads are deliberately flat. Arbitrary tool arguments, authorization
// headers, and MCP responses have no valid field. Terminal records use a bounded,
// redacted projection of approved commands and outputs.
var agentEventFields = map[string]map[string]string{
	"user":               {"preview": "string", "truncated": "bool"},
	"assistant":          {"preview": "string", "truncated": "bool"},
	"assistant_progress": {"preview": "string"},
	"run_started":        {"model": "string"},
	"tool_proposed":      {"tool_name": "string", "target": "string", "arguments_sha256": "string", "preview": "string", "mcp_server": "string", "mcp_tool": "string", "activity_kind": "string", "activity_action": "string", "activity_count": "int"},
	"tool_decision":      {"outcome": "string", "reason": "string"},
	"tool_finished":      {"status": "string", "preview": "string", "duration_ms": "int", "error_code": "presentation_error"},
	"model_usage":        {"input_tokens": "int", "output_tokens": "int", "estimated": "bool"},
	"summary_created":    {"through_seq": "int", "token_estimate": "int"},
	"answer_finished":    {"status": "string"},
	"run_failed":         {"reason": "string"},
	"specialist":         {"name": "string", "status": "string", "preview": "string"},
	"workflow":           {"run_id": "string", "name": "string", "status": "string", "step_name": "string", "step_status": "string", "completed": "int", "total": "int", "planning_json": "string"},
	"skill_loaded":       {"name": "string", "scope": "string", "sha256": "string"},
	"question_asked":     {"question_id": "string", "questions_json": "string"},
	"question_answered":  {"question_id": "string", "answers_json": "string"},
	"visual_report":      {"report_id": "string", "report_json": "visual_report"},
	"a2ui":               {"ui_json": "a2ui"},
	"ui_action":          {"surface_id": "string", "component_id": "string", "name": "string", "context_sha256": "string"},
	"terminal_proposed":  {"proposal_id": "string", "command": "string", "target": "string", "kind": "string"},
	"terminal_control":   {"proposal_id": "string", "owner": "string", "status": "string"},
}

func init() {
	fields := map[string]string{"actor": "string", "id": "string", "sequence": "int", "scope_id": "string", "target": "string", "session_id": "string", "working_directory": "string", "next_directory": "string", "user": "string", "command": "string", "stdout": "string", "stderr": "string", "status": "string", "error": "string", "exit_code": "signed_int", "duration_ms": "int", "truncated": "bool"}
	agentEventFields["execution_started"] = fields
	agentEventFields["execution_finished"] = fields
}

func checkedEventPayload(kind string, payload json.RawMessage) (json.RawMessage, error) {
	fields, ok := agentEventFields[kind]
	if !ok || len(payload) == 0 || len(payload) > maxAgentEventPayload {
		return nil, errors.New("invalid agent event payload")
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(payload, &values); err != nil || values == nil {
		return nil, errors.New("invalid agent event payload")
	}
	for name, value := range values {
		typ, allowed := fields[name]
		if !allowed {
			return nil, errors.New("agent event contains a disallowed field")
		}
		switch typ {
		case "presentation_error":
			var code string
			if json.Unmarshal(value, &code) != nil || (code != "invalid_ui" && code != "invalid_report" && code != "presentation_unavailable") {
				return nil, errors.New("invalid presentation error code")
			}
		case "a2ui":
			var body string
			var snapshot agent.UISnapshot
			if json.Unmarshal(value, &body) != nil || json.Unmarshal([]byte(body), &snapshot) != nil {
				return nil, errors.New("invalid A2UI event")
			}
			snapshot, err := SanitizeUISnapshot(snapshot)
			if err != nil {
				return nil, err
			}
			encoded, _ := json.Marshal(snapshot)
			values[name], _ = json.Marshal(string(encoded))
		case "visual_report":
			var body string
			if json.Unmarshal(value, &body) != nil {
				return nil, errors.New("invalid visual report event")
			}
			report, err := agent.ParseVisualReport([]byte(body))
			if err != nil {
				return nil, err
			}
			report, err = SanitizeVisualReport(report)
			if err != nil {
				return nil, err
			}
			encoded, _ := json.Marshal(report)
			values[name], _ = json.Marshal(string(encoded))
		case "string":
			var text string
			if err := json.Unmarshal(value, &text); err != nil || string(value) == "null" {
				return nil, errors.New("invalid agent event string")
			}
			if sensitiveEventText(text) {
				text = "[redacted]"
			}
			value, _ = json.Marshal(text)
			values[name] = value
		case "bool":
			var boolean bool
			if err := json.Unmarshal(value, &boolean); err != nil || string(value) == "null" {
				return nil, errors.New("invalid agent event boolean")
			}
		case "int", "signed_int":
			var number int64
			if err := json.Unmarshal(value, &number); err != nil || string(value) == "null" || (typ == "int" && number < 0) {
				return nil, errors.New("invalid agent event number")
			}
		}
	}
	if kind == "visual_report" {
		var id string
		if json.Unmarshal(values["report_id"], &id) != nil || id == "" || len(id) > 128 || len(values["report_json"]) == 0 {
			return nil, errors.New("invalid visual report identity")
		}
	}
	if kind == "question_asked" || kind == "question_answered" {
		var id string
		if json.Unmarshal(values["question_id"], &id) != nil || id == "" || len(id) > 128 {
			return nil, errors.New("invalid question event identity")
		}
		if kind == "question_asked" {
			var body string
			var questions []agent.UserQuestion
			if json.Unmarshal(values["questions_json"], &body) != nil {
				return nil, errors.New("invalid question event")
			}
			decoder := json.NewDecoder(strings.NewReader(body))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&questions) != nil {
				return nil, errors.New("invalid question event fields")
			}
			var extra any
			if !errors.Is(decoder.Decode(&extra), io.EOF) {
				return nil, errors.New("invalid question event content")
			}
			if err := (agent.UserQuestionInput{Questions: questions}).Validate(); err != nil {
				return nil, err
			}
		} else {
			var body string
			var answers map[string]string
			if json.Unmarshal(values["answers_json"], &body) != nil || json.Unmarshal([]byte(body), &answers) != nil {
				return nil, errors.New("invalid answer event")
			}
			if err := (agent.UserQuestionAnswer{Answers: answers}).Validate(); err != nil {
				return nil, err
			}
		}
	}
	encoded, err := json.Marshal(values)
	if err != nil || len(encoded) > maxAgentEventPayload {
		return nil, errors.New("agent event payload exceeds limit")
	}
	return encoded, nil
}

func sensitiveEventText(value string) bool {
	upper := strings.ToUpper(value)
	return strings.Contains(upper, "PRIVATE KEY-----") || strings.Contains(upper, "AUTHORIZATION:") || strings.Contains(upper, "BEARER ") || strings.Contains(upper, "API_KEY=") || strings.Contains(upper, "API-KEY:")
}

func (s *Store) AppendAgentEvent(ctx context.Context, conversationID string, input AgentEventInput) (ConversationEvent, error) {
	if conversationID == "" || input.Actor == "" || len(input.Actor) > 128 || len(input.ToolCallID) > 128 {
		return ConversationEvent{}, errors.New("invalid agent event identity")
	}
	payload, err := checkedEventPayload(input.Kind, input.Payload)
	if err != nil {
		return ConversationEvent{}, err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return ConversationEvent{}, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return ConversationEvent{}, err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var exists int
	if err := conn.QueryRowContext(ctx, `SELECT 1 FROM conversation WHERE id=? AND archived_at IS NULL`, conversationID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ConversationEvent{}, ErrNotFound
		}
		return ConversationEvent{}, err
	}
	var sequence uint64
	if err := conn.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0)+1 FROM conversation_event WHERE conversation_id=?`, conversationID).Scan(&sequence); err != nil {
		return ConversationEvent{}, err
	}
	now := nowMillis()
	if _, err := conn.ExecContext(ctx, `INSERT INTO conversation_event(conversation_id,seq,kind,actor,tool_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?)`, conversationID, sequence, input.Kind, input.Actor, input.ToolCallID, string(payload), now); err != nil {
		return ConversationEvent{}, err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return ConversationEvent{}, err
	}
	return ConversationEvent{ConversationID: conversationID, Sequence: sequence, Kind: input.Kind, Actor: input.Actor, ToolCallID: input.ToolCallID, Payload: payload, CreatedAt: fromMillis(now)}, nil
}

func (s *Store) ListAgentEvents(ctx context.Context, conversationID string, after uint64, limit int) ([]ConversationEvent, error) {
	if limit < 1 || limit > 500 {
		return nil, errors.New("agent event page limit must be between 1 and 500")
	}
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT seq,kind,actor,tool_call_id,COALESCE(legacy_turn_id,''),payload,created_at FROM conversation_event WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?`, conversationID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]ConversationEvent, 0)
	for rows.Next() {
		var event ConversationEvent
		var payload string
		var created int64
		if err := rows.Scan(&event.Sequence, &event.Kind, &event.Actor, &event.ToolCallID, &event.LegacyTurnID, &payload, &created); err != nil {
			return nil, err
		}
		event.ConversationID = conversationID
		event.Payload = json.RawMessage(payload)
		event.CreatedAt = fromMillis(created)
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) SaveConversationSummary(ctx context.Context, conversationID string, input ConversationSummaryInput) error {
	if input.ThroughSeq == 0 || input.Text == "" || len(input.Text) > maxAgentEventPayload || input.TokenEstimate < 0 || len(input.SourceEventIDs) == 0 || sensitiveEventText(input.Text) {
		return errors.New("invalid conversation summary")
	}
	seen := make(map[uint64]struct{}, len(input.SourceEventIDs))
	for _, source := range input.SourceEventIDs {
		if source == 0 || source > input.ThroughSeq {
			return errors.New("summary source is outside its event range")
		}
		if _, ok := seen[source]; ok {
			return errors.New("duplicate summary source")
		}
		seen[source] = struct{}{}
	}
	sources, err := json.Marshal(input.SourceEventIDs)
	if err != nil {
		return err
	}
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return err
	}
	var maxSeq uint64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM conversation_event WHERE conversation_id=?`, conversationID).Scan(&maxSeq); err != nil {
		return err
	}
	if input.ThroughSeq > maxSeq {
		return fmt.Errorf("summary event %d is beyond latest event %d", input.ThroughSeq, maxSeq)
	}
	taskState, err := s.checkedTaskState(ctx, conversationID, input)
	if err != nil {
		return err
	}
	// Preserved pending messages can have smaller sequence numbers than the
	// summary watermark. Once released, summarizing them revises coverage at
	// the same watermark. Allow that revision only if it retains all sources.
	result, err := s.db.ExecContext(ctx, `INSERT INTO conversation_summary(conversation_id,through_seq,text,source_event_ids,token_estimate,created_at,task_state) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(conversation_id,through_seq) DO UPDATE SET text=excluded.text,source_event_ids=excluded.source_event_ids,token_estimate=excluded.token_estimate,created_at=excluded.created_at,task_state=excluded.task_state
		WHERE NOT EXISTS (SELECT 1 FROM json_each(conversation_summary.source_event_ids) old
			WHERE NOT EXISTS (SELECT 1 FROM json_each(excluded.source_event_ids) fresh WHERE fresh.value=old.value))`, conversationID, input.ThroughSeq, input.Text, string(sources), input.TokenEstimate, nowMillis(), taskState)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return errors.New("摘要修订不能丢失既有来源")
	}
	return nil
}

func (s *Store) LatestConversationSummary(ctx context.Context, conversationID string) (*ConversationSummary, error) {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return nil, err
	}
	var summary ConversationSummary
	var sourceJSON, taskJSON string
	var created int64
	err := s.db.QueryRowContext(ctx, `SELECT through_seq,text,source_event_ids,token_estimate,created_at,task_state FROM conversation_summary WHERE conversation_id=? ORDER BY through_seq DESC LIMIT 1`, conversationID).
		Scan(&summary.ThroughSeq, &summary.Text, &sourceJSON, &summary.TokenEstimate, &created, &taskJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(sourceJSON), &summary.SourceEventIDs); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(taskJSON), &summary.TaskState); err != nil {
		return nil, err
	}
	if err := agent.ValidateTaskState(summary.TaskState, summary.SourceEventIDs); err != nil {
		return nil, err
	}
	summary.ConversationID = conversationID
	summary.CreatedAt = fromMillis(created)
	return &summary, nil
}
