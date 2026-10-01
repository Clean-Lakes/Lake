package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/lake/agent"
)

func (s *Store) migrateV19(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err = conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version < 19 {
		if version != 18 {
			return fmt.Errorf("unexpected schema version before v19: %d", version)
		}
		rows, err := conn.QueryContext(ctx, "PRAGMA table_info(conversation_summary)")
		if err != nil {
			return err
		}
		exists := false
		for rows.Next() {
			var ordinal, notNull, primary int
			var name, typ string
			var defaultValue any
			if err := rows.Scan(&ordinal, &name, &typ, &notNull, &defaultValue, &primary); err != nil {
				rows.Close()
				return err
			}
			exists = exists || name == "task_state"
		}
		rowErr := rows.Err()
		rows.Close()
		if rowErr != nil {
			return rowErr
		}
		if !exists {
			if _, err = conn.ExecContext(ctx, "ALTER TABLE conversation_summary ADD COLUMN task_state TEXT NOT NULL DEFAULT 'null'"); err != nil {
				return err
			}
		}
		if _, err = conn.ExecContext(ctx, "PRAGMA user_version=19"); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) checkedTaskState(ctx context.Context, conversationID string, input ConversationSummaryInput) (string, error) {
	if err := agent.ValidateTaskState(input.TaskState, input.SourceEventIDs); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(input.TaskState)
	if err != nil || len(encoded) > maxAgentEventPayload || sensitiveEventText(string(encoded)) {
		return "", errors.New("invalid task checkpoint content")
	}
	userFacts := map[uint64][]string{}
	if input.TaskState != nil {
		for _, fact := range append(append([]agent.TaskFact(nil), input.TaskState.Goals...), input.TaskState.Constraints...) {
			for _, source := range fact.SourceEventIDs {
				userFacts[source] = append(userFacts[source], fact.Text)
			}
		}
	}
	// Verify the whole coverage set, not just the watermark. IDs are local to
	// each conversation, and assistant text cannot become a quoted user goal.
	wanted := map[uint64]bool{}
	for _, source := range input.SourceEventIDs {
		wanted[source] = true
	}
	rows, err := s.db.QueryContext(ctx, `SELECT e.seq,e.kind,COALESCE(t.prompt,json_extract(e.payload,'$.preview'),'')
		FROM conversation_event e LEFT JOIN conversation_turn t ON t.id=e.legacy_turn_id
		WHERE e.conversation_id=? AND e.seq<=?`, conversationID, input.ThroughSeq)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var seq uint64
		var kind, original string
		if err := rows.Scan(&seq, &kind, &original); err != nil {
			return "", err
		}
		delete(wanted, seq)
		for _, quote := range userFacts[seq] {
			if kind != "user" || !strings.Contains(original, quote) {
				return "", errors.New("task goal or constraint is not an original user quote")
			}
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(wanted) != 0 {
		return "", errors.New("task checkpoint source is not in this conversation")
	}
	return string(encoded), nil
}
