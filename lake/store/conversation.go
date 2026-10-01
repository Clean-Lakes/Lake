package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

type Conversation struct {
	ID                  string    `json:"id"`
	LakeID              string    `json:"lake_id"`
	Lake                string    `json:"lake"`
	Title               string    `json:"title"`
	ProjectID           string    `json:"project_id,omitempty"`
	ProjectName         string    `json:"project_name,omitempty"`
	ProjectPath         string    `json:"project_path,omitempty"`
	RemoteWorkspaceID   string    `json:"remote_workspace_id,omitempty"`
	RemoteWorkspaceName string    `json:"remote_workspace_name,omitempty"`
	RemoteRoot          string    `json:"remote_root,omitempty"`
	RemoteHost          string    `json:"remote_host,omitempty"`
	RemoteUsername      string    `json:"remote_username,omitempty"`
	RemotePort          int       `json:"remote_port,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type ConversationTurn struct {
	ID                string            `json:"id"`
	Prompt            string            `json:"prompt"`
	Answer            string            `json:"answer"`
	Display           string            `json:"display"`
	Error             string            `json:"error"`
	Images            []ImageAttachment `json:"images,omitempty"`
	Specialists       []SpecialistCall  `json:"specialists,omitempty"`
	UserEventSeq      uint64            `json:"user_event_seq,omitempty"`
	AssistantEventSeq uint64            `json:"assistant_event_seq,omitempty"`
	CreatedAt         time.Time         `json:"created_at"`
}

// SpecialistCall records a delegated agent or workflow execution trace.
type SpecialistCall struct {
	ID        string              `json:"id"`
	Kind      string              `json:"kind"`
	Name      string              `json:"name,omitempty"`
	Task      string              `json:"task"`
	Stage     string              `json:"stage"`
	RunID     string              `json:"run_id,omitempty"`
	Completed int                 `json:"completed,omitempty"`
	Total     int                 `json:"total,omitempty"`
	Steps     []WorkflowStepTrace `json:"steps,omitempty"`
	Planning  json.RawMessage     `json:"planning,omitempty"`
}

type WorkflowStepTrace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Resource string `json:"resource"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	Message  string `json:"message,omitempty"`
}

func (s *Store) CreateConversation(ctx context.Context, lakeName string) (Conversation, error) {
	lake, err := s.GetLakeByName(ctx, lakeName)
	if err != nil {
		return Conversation{}, err
	}
	id, err := newID()
	if err != nil {
		return Conversation{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO conversation(id,lake_id,title,created_at,updated_at) VALUES(?,?,'新会话',?,?)`, id, lake.ID, now, now); err != nil {
		return Conversation{}, err
	}
	return Conversation{ID: id, LakeID: lake.ID, Lake: lake.Name, Title: "新会话", CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func scanConversation(row scanner) (Conversation, error) {
	var c Conversation
	var projectID, projectName, projectPath sql.NullString
	var remoteID, remoteName, remoteRoot, remoteSpec sql.NullString
	var created, updated int64
	err := row.Scan(&c.ID, &c.LakeID, &c.Lake, &c.Title, &created, &updated, &projectID, &projectName, &projectPath, &remoteID, &remoteName, &remoteRoot, &remoteSpec)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	c.CreatedAt, c.UpdatedAt = fromMillis(created), fromMillis(updated)
	c.ProjectID, c.ProjectName, c.ProjectPath = projectID.String, projectName.String, projectPath.String
	c.RemoteWorkspaceID, c.RemoteWorkspaceName, c.RemoteRoot = remoteID.String, remoteName.String, remoteRoot.String
	if remoteSpec.Valid {
		var decoded struct {
			SSH SSHSpec `json:"ssh"`
		}
		if err := json.Unmarshal([]byte(remoteSpec.String), &decoded); err != nil {
			return Conversation{}, err
		}
		c.RemoteHost, c.RemotePort, c.RemoteUsername = decoded.SSH.Host, decoded.SSH.Port, decoded.SSH.Username
	}
	return c, nil
}

const conversationSelect = `SELECT c.id,c.lake_id,l.name,c.title,c.created_at,c.updated_at,p.id,p.name,p.path,w.id,w.name,w.remote_root,r.spec FROM conversation c JOIN lake l ON l.id=c.lake_id LEFT JOIN code_project p ON p.id=c.project_id LEFT JOIN code_workspace w ON w.id=c.remote_workspace_id LEFT JOIN resource r ON r.id=w.resource_id`

func (s *Store) GetConversation(ctx context.Context, id string) (Conversation, error) {
	return scanConversation(s.db.QueryRowContext(ctx, conversationSelect+` WHERE c.id=? AND c.archived_at IS NULL`, id))
}

func (s *Store) ListConversations(ctx context.Context) ([]Conversation, error) {
	rows, err := s.db.QueryContext(ctx, conversationSelect+` WHERE c.archived_at IS NULL ORDER BY c.updated_at DESC,c.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListArchivedConversations(ctx context.Context) ([]Conversation, error) {
	rows, err := s.db.QueryContext(ctx, conversationSelect+` WHERE c.archived_at IS NOT NULL ORDER BY c.archived_at DESC,c.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) RenameConversation(ctx context.Context, id, title string) (Conversation, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > 100 {
		return Conversation{}, errors.New("会话标题须为 1–100 字")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE conversation SET title=?,updated_at=? WHERE id=? AND archived_at IS NULL`, title, nowMillis(), id)
	if err != nil {
		return Conversation{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return Conversation{}, ErrNotFound
	}
	return s.GetConversation(ctx, id)
}

func (s *Store) ArchiveConversation(ctx context.Context, id string) error {
	now := nowMillis()
	result, err := s.db.ExecContext(ctx, `UPDATE conversation SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL`, now, now, id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RestoreConversation(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE conversation SET archived_at=NULL,updated_at=? WHERE id=? AND archived_at IS NOT NULL`, nowMillis(), id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListConversationTurns(ctx context.Context, id string) ([]ConversationTurn, error) {
	if _, err := s.GetConversation(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,prompt,answer,display,error,images,specialists,created_at FROM conversation_turn WHERE conversation_id=? ORDER BY created_at,rowid`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ConversationTurn, 0)
	for rows.Next() {
		var turn ConversationTurn
		var created int64
		var imageJSON, specialistJSON string
		if err := rows.Scan(&turn.ID, &turn.Prompt, &turn.Answer, &turn.Display, &turn.Error, &imageJSON, &specialistJSON, &created); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(imageJSON), &turn.Images); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(specialistJSON), &turn.Specialists); err != nil {
			return nil, err
		}
		turn.CreatedAt = fromMillis(created)
		out = append(out, turn)
	}
	return out, rows.Err()
}

func (s *Store) AppendConversationTurn(ctx context.Context, id, prompt, answer, display, turnError string) (ConversationTurn, error) {
	return s.AppendConversationTurnWithImages(ctx, id, prompt, answer, display, turnError, nil)
}

func (s *Store) AppendConversationTurnWithImages(ctx context.Context, id, prompt, answer, display, turnError string, images []ImageAttachment) (ConversationTurn, error) {
	return s.AppendConversationTurnWithDetails(ctx, id, prompt, answer, display, turnError, images, nil)
}

func (s *Store) AppendConversationTurnWithDetails(ctx context.Context, id, prompt, answer, display, turnError string, images []ImageAttachment, specialists []SpecialistCall) (ConversationTurn, error) {
	return s.AppendConversationTurnWithDetailsAndUserEvent(ctx, id, prompt, answer, display, turnError, images, specialists, 0)
}

// AppendConversationTurnWithDetailsAndUserEvent atomically links an earlier
// user event and writes the final assistant event with the legacy turn.
func (s *Store) AppendConversationTurnWithDetailsAndUserEvent(ctx context.Context, id, prompt, answer, display, turnError string, images []ImageAttachment, specialists []SpecialistCall, userEventSeq uint64) (ConversationTurn, error) {
	if strings.TrimSpace(prompt) == "" {
		return ConversationTurn{}, errors.New("会话消息不能为空")
	}
	if err := ValidateImages(images); err != nil {
		return ConversationTurn{}, err
	}
	imageJSON, err := json.Marshal(images)
	if err != nil {
		return ConversationTurn{}, err
	}
	if len(specialists) > 32 {
		return ConversationTurn{}, errors.New("专员调用记录过多")
	}
	for _, call := range specialists {
		if call.ID == "" || len(call.ID) > 128 || len(call.Task) > 512 || (call.Kind != "ssh" && call.Kind != "code" && call.Kind != "workflow" && call.Kind != "specialist") || len(call.Name) > 64 || len(call.Steps) > 32 {
			return ConversationTurn{}, errors.New("无效的专员调用记录")
		}
		switch call.Stage {
		case "delegated", "working", "returned", "completed", "failed":
		default:
			return ConversationTurn{}, errors.New("无效的专员调用状态")
		}
	}
	specialistJSON, err := json.Marshal(specialists)
	if err != nil {
		return ConversationTurn{}, err
	}
	turnID, err := newID()
	if err != nil {
		return ConversationTurn{}, err
	}
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ConversationTurn{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE conversation SET updated_at=?,title=CASE WHEN title='新会话' AND NOT EXISTS(SELECT 1 FROM conversation_turn WHERE conversation_id=?) THEN ? ELSE title END WHERE id=? AND archived_at IS NULL`, now, id, titleFromPrompt(prompt), id)
	if err != nil {
		return ConversationTurn{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ConversationTurn{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO conversation_turn(id,conversation_id,prompt,answer,display,error,images,specialists,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, turnID, id, prompt, answer, display, turnError, string(imageJSON), string(specialistJSON), now); err != nil {
		return ConversationTurn{}, err
	}
	var nextSequence uint64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0)+1 FROM conversation_event WHERE conversation_id=?`, id).Scan(&nextSequence); err != nil {
		return ConversationTurn{}, err
	}
	items := []struct {
		kind  string
		actor string
		text  string
	}{
		{kind: "assistant", actor: "assistant", text: answer},
	}
	if userEventSeq == 0 {
		userEventSeq = nextSequence
		items = append([]struct {
			kind  string
			actor string
			text  string
		}{{kind: "user", actor: "user", text: prompt}}, items...)
	} else {
		result, err := tx.ExecContext(ctx, `UPDATE conversation_event SET legacy_turn_id=? WHERE conversation_id=? AND seq=? AND kind='user' AND legacy_turn_id IS NULL`, turnID, id, userEventSeq)
		if err != nil {
			return ConversationTurn{}, err
		}
		if n, _ := result.RowsAffected(); n != 1 {
			return ConversationTurn{}, errors.New("user event does not belong to this unfinished turn")
		}
	}
	for offset, item := range items {
		payload, err := turnEventPayload(item.kind, item.text)
		if err != nil {
			return ConversationTurn{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO conversation_event(conversation_id,seq,kind,actor,payload,legacy_turn_id,created_at) VALUES(?,?,?,?,?,?,?)`, id, nextSequence+uint64(offset), item.kind, item.actor, string(payload), turnID, now); err != nil {
			return ConversationTurn{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return ConversationTurn{}, err
	}
	return ConversationTurn{ID: turnID, Prompt: prompt, Answer: answer, Display: display, Error: turnError, Images: images, Specialists: specialists, UserEventSeq: userEventSeq, AssistantEventSeq: nextSequence + uint64(len(items)-1), CreatedAt: fromMillis(now)}, nil
}

func turnEventPayload(kind, text string) (json.RawMessage, error) {
	runes := []rune(text)
	truncated := len(runes) > 2048
	if truncated {
		text = string(runes[:2048])
	}
	raw, err := json.Marshal(map[string]any{"preview": text, "truncated": truncated})
	if err != nil {
		return nil, err
	}
	return checkedEventPayload(kind, raw)
}

func titleFromPrompt(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	runes := []rune(line)
	if len(runes) > 36 {
		return string(runes[:36]) + "…"
	}
	return line
}
