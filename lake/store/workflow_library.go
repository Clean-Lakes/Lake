package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Organization is separate from definitions and run snapshots. Moving an entry
// changes only its location in the library, never its execution scope or revision.
type WorkflowLibraryEntry struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	LakeID      string `json:"lake_id"`
	Lake        string `json:"lake"`
	ParentID    string `json:"parent_id"`
	Position    int    `json:"position"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type WorkflowLibraryRequest struct {
	Action     string `json:"action"`
	Lake       string `json:"lake,omitempty"`
	Kind       string `json:"kind,omitempty"`
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	ParentID   string `json:"parent_id,omitempty"`
	BeforeKind string `json:"before_kind,omitempty"`
	BeforeID   string `json:"before_id,omitempty"`
}

type WorkflowLibrary struct {
	Entries   []WorkflowLibraryEntry `json:"entries"`
	CreatedID string                 `json:"created_id,omitempty"`
}

const migrationV18 = `
CREATE TABLE IF NOT EXISTS workflow_organization (
  kind TEXT NOT NULL CHECK(kind IN ('folder','v1','v2')),
  id TEXT NOT NULL,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK(position >= 0),
  name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS workflow_organization_parent ON workflow_organization(lake_id,parent_id,position);
`

func (s *Store) migrateV18(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version < 18 {
		if version != 17 {
			return fmt.Errorf("unexpected schema version before v18: %d", version)
		}
		if _, err := conn.ExecContext(ctx, migrationV18); err != nil {
			return fmt.Errorf("migrate schema v18: %w", err)
		}
		if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 18"); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

type workflowLibraryReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readWorkflowLibrary(ctx context.Context, db workflowLibraryReader, lake string) (WorkflowLibrary, error) {
	query := `SELECT * FROM (
SELECT o.kind,o.id,o.lake_id,l.name AS lake,o.parent_id,o.position,o.name,'' AS description,1 AS enabled
FROM workflow_organization o JOIN lake l ON l.id=o.lake_id WHERE o.kind='folder'
UNION ALL
SELECT 'v1',w.id,w.lake_id,l.name,COALESCE(o.parent_id,''),COALESCE(o.position,2147483647),w.name,w.description,w.enabled
FROM ops_workflow w JOIN lake l ON l.id=w.lake_id LEFT JOIN workflow_organization o ON o.kind='v1' AND o.id=w.id AND o.lake_id=w.lake_id
UNION ALL
SELECT 'v2',w.id,w.lake_id,l.name,COALESCE(o.parent_id,''),COALESCE(o.position,2147483647),w.name,w.description,w.enabled
FROM workflow_v2_definition w JOIN lake l ON l.id=w.lake_id LEFT JOIN workflow_organization o ON o.kind='v2' AND o.id=w.id AND o.lake_id=w.lake_id
)`
	var args []any
	if lake != "" {
		query += ` WHERE lake=?`
		args = append(args, lake)
	}
	query += ` ORDER BY lake,parent_id,position,lower(name),kind,id`
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return WorkflowLibrary{}, err
	}
	defer rows.Close()
	library := WorkflowLibrary{Entries: make([]WorkflowLibraryEntry, 0)}
	for rows.Next() {
		var entry WorkflowLibraryEntry
		var enabled int
		if err := rows.Scan(&entry.Kind, &entry.ID, &entry.LakeID, &entry.Lake, &entry.ParentID, &entry.Position, &entry.Name, &entry.Description, &enabled); err != nil {
			return WorkflowLibrary{}, err
		}
		entry.Enabled = enabled == 1
		library.Entries = append(library.Entries, entry)
	}
	return library, rows.Err()
}

func (s *Store) ManageWorkflowLibrary(ctx context.Context, req WorkflowLibraryRequest) (WorkflowLibrary, error) {
	if req.Action == "list" {
		return readWorkflowLibrary(ctx, s.db, req.Lake)
	}
	if req.Lake == "" {
		return WorkflowLibrary{}, errors.New("目录操作需要指定所属湖")
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return WorkflowLibrary{}, err
	}
	defer conn.Close()
	// Serialize the snapshot, cycle checks and ordering across all Lake processes.
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return WorkflowLibrary{}, err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var lakeID string
	if err := conn.QueryRowContext(ctx, `SELECT id FROM lake WHERE name=?`, req.Lake).Scan(&lakeID); err != nil {
		return WorkflowLibrary{}, ErrNotFound
	}
	library, err := readWorkflowLibrary(ctx, conn, req.Lake)
	if err != nil {
		return WorkflowLibrary{}, err
	}
	find := func(kind, id string) (WorkflowLibraryEntry, bool) {
		for _, entry := range library.Entries {
			if entry.Kind == kind && entry.ID == id {
				return entry, true
			}
		}
		return WorkflowLibraryEntry{}, false
	}
	if req.ParentID != "" {
		if _, ok := find("folder", req.ParentID); !ok {
			return WorkflowLibrary{}, errors.New("目标目录不存在或属于其他湖")
		}
	}
	uniqueName := func(name, parent, except string) error {
		if err := validName(name); err != nil {
			return errors.New("目录名不能为空、过长或包含路径分隔符")
		}
		for _, entry := range library.Entries {
			if entry.Kind == "folder" && entry.ParentID == parent && entry.ID != except && strings.EqualFold(entry.Name, name) {
				return errors.New("同级目录名称已存在")
			}
		}
		return nil
	}
	createdID := ""
	switch req.Action {
	case "create_folder", "move":
		var moving WorkflowLibraryEntry
		if req.Action == "create_folder" {
			if err := uniqueName(req.Name, req.ParentID, ""); err != nil {
				return WorkflowLibrary{}, err
			}
			id, err := newID()
			if err != nil {
				return WorkflowLibrary{}, err
			}
			createdID = id
			moving = WorkflowLibraryEntry{Kind: "folder", ID: id, LakeID: lakeID, Lake: req.Lake, Name: req.Name, Enabled: true}
		} else {
			var ok bool
			moving, ok = find(req.Kind, req.ID)
			if !ok {
				return WorkflowLibrary{}, errors.New("移动对象不存在或属于其他湖")
			}
			if moving.Kind == "folder" {
				if err := uniqueName(moving.Name, req.ParentID, moving.ID); err != nil {
					return WorkflowLibrary{}, err
				}
				seen := map[string]bool{}
				for parent := req.ParentID; parent != ""; {
					if parent == moving.ID || seen[parent] {
						return WorkflowLibrary{}, errors.New("不能将目录移入自身或子目录")
					}
					seen[parent] = true
					entry, ok := find("folder", parent)
					if !ok {
						return WorkflowLibrary{}, errors.New("目录层级无效")
					}
					parent = entry.ParentID
				}
			}
		}
		if (req.BeforeKind == "") != (req.BeforeID == "") {
			return WorkflowLibrary{}, errors.New("排序目标无效")
		}
		if req.BeforeID == moving.ID && req.BeforeKind == moving.Kind {
			if moving.ParentID != req.ParentID {
				return WorkflowLibrary{}, errors.New("排序目标不在目标目录")
			}
		} else {
			siblings := make([]WorkflowLibraryEntry, 0)
			for _, entry := range library.Entries {
				if entry.ParentID == req.ParentID && !(entry.ID == moving.ID && entry.Kind == moving.Kind) {
					siblings = append(siblings, entry)
				}
			}
			index := len(siblings)
			if req.BeforeID != "" {
				index = -1
				for at, entry := range siblings {
					if entry.Kind == req.BeforeKind && entry.ID == req.BeforeID {
						index = at
						break
					}
				}
				if index < 0 {
					return WorkflowLibrary{}, errors.New("排序目标已移动，请刷新后重试")
				}
			}
			siblings = append(siblings, WorkflowLibraryEntry{})
			copy(siblings[index+1:], siblings[index:])
			siblings[index] = moving
			for position, entry := range siblings {
				_, err := conn.ExecContext(ctx, `INSERT INTO workflow_organization(kind,id,lake_id,parent_id,position,name) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=excluded.parent_id,position=excluded.position,name=excluded.name WHERE workflow_organization.lake_id=excluded.lake_id`, entry.Kind, entry.ID, lakeID, req.ParentID, position, entry.Name)
				if err != nil {
					return WorkflowLibrary{}, err
				}
			}
		}
	case "rename_folder":
		entry, ok := find("folder", req.ID)
		if !ok {
			return WorkflowLibrary{}, ErrNotFound
		}
		if err := uniqueName(req.Name, entry.ParentID, entry.ID); err != nil {
			return WorkflowLibrary{}, err
		}
		if _, err := conn.ExecContext(ctx, `UPDATE workflow_organization SET name=? WHERE kind='folder' AND id=? AND lake_id=?`, req.Name, req.ID, lakeID); err != nil {
			return WorkflowLibrary{}, err
		}
	case "delete_folder":
		if _, ok := find("folder", req.ID); !ok {
			return WorkflowLibrary{}, ErrNotFound
		}
		for _, entry := range library.Entries {
			if entry.ParentID == req.ID {
				return WorkflowLibrary{}, errors.New("目录非空，请先移出其中的工作流和子目录")
			}
		}
		if _, err := conn.ExecContext(ctx, `DELETE FROM workflow_organization WHERE kind='folder' AND id=? AND lake_id=?`, req.ID, lakeID); err != nil {
			return WorkflowLibrary{}, err
		}
	default:
		return WorkflowLibrary{}, errors.New("未知目录操作")
	}
	result, err := readWorkflowLibrary(ctx, conn, "")
	if err != nil {
		return WorkflowLibrary{}, err
	}
	result.CreatedID = createdID
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return WorkflowLibrary{}, err
	}
	return result, nil
}
