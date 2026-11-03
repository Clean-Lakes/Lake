package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
)

type superTaskReferenceRow struct {
	TaskID         string `gorm:"primaryKey"`
	SourceTaskID   string `gorm:"primaryKey"`
	ProjectID      string
	SourceRevision int64
	CreatedAt      time.Time
}

func (superTaskReferenceRow) TableName() string { return "superagent_task_references" }

func referencedTaskEvidenceTools() []Tool {
	return []Tool{
		{Name: "list_referenced_task_evidence", Description: "List exact historical evidence references for a source task explicitly registered to this comparison task. Never reads another Worker's transcript or grants resource access. Continue using nextCursor.", Parameters: objectSchema(map[string]any{"task_id": stringSchema(), "cursor": stringSchema(), "limit": integerSchema(1, 50)}, "task_id")},
		{Name: "read_referenced_task_evidence", Description: "After work_begin confirmation and work_update(running), read one registered immutable evidence reference, up to 2048 bytes. The host records this historical read in the current attempt for independent manual acceptance; it never accepts the source task or establishes current health. Every page revalidates project, policy, source revision, resource connection and evidence identity. Missing, stale, failed and unknown results must be reported accurately.", Parameters: objectSchema(map[string]any{"task_id": stringSchema(), "evidence_id": stringSchema(), "reference_id": stringSchema(), "offset": integerSchema(0, 100000000), "limit": integerSchema(1, 2048)}, "task_id", "evidence_id", "reference_id")},
	}
}

func (e *Engine) superTaskReferenceContext(ctx context.Context, project, task string) (string, error) {
	db, err := e.superStore()
	if err != nil {
		return "", err
	}
	var rows []superTaskReferenceRow
	if err := db.WithContext(ctx).Where("project_id = ? AND task_id = ?", project, task).Order("source_task_id").Find(&rows).Error; err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	ids := []string{}
	for _, row := range rows {
		ids = append(ids, row.SourceTaskID)
	}
	return "\n[REGISTERED HISTORICAL TASK REFERENCES]\n" + js(ids) + "\nUse list_referenced_task_evidence for discovery. Confirm the comparison plan and set its actual item running before read_referenced_task_evidence; the host records each read in this attempt for manual verification. Include comparison and acceptance in one substantive item, not an evidence-free final item. These are historical read-only sources, not execution permissions or completed acceptance. Missing evidence must remain a stated gap.", nil
}

// References carry read-only provenance. They never copy scope, attempts,
// execution owners, approval state or permits into the comparison task.
func registerSuperTaskReferencesTx(tx *gorm.DB, project, task string, sources []string) error {
	if len(sources) > 8 {
		return errSuperBinding
	}
	seen := map[string]bool{}
	for _, id := range sources {
		if id == task || id == "" || seen[id] {
			return errSuperBinding
		}
		seen[id] = true
		var worker superWorkerRow
		if err := tx.First(&worker, "task_id = ? AND project_id = ? AND parent_worker_id = ''", id, project).Error; err != nil {
			return err
		}
		view, err := projectSuperTaskTx(tx, worker.goalSession(), id)
		if err != nil {
			return err
		}
		if err := tx.Create(&superTaskReferenceRow{TaskID: task, SourceTaskID: id, ProjectID: project, SourceRevision: view.Revision, CreatedAt: time.Now().UTC()}).Error; err != nil {
			return err
		}
	}
	return nil
}

type TaskEvidenceRef struct {
	ID                string    `json:"id"`
	TaskID            string    `json:"taskId"`
	GoalRevision      int64     `json:"goalRevision"`
	TaskRevision      int64     `json:"taskRevision"`
	AttemptID         string    `json:"attemptId"`
	OperationID       string    `json:"operationId"`
	EvidenceID        string    `json:"evidenceId"`
	ResourceID        string    `json:"resourceId"`
	ConnectionVersion int64     `json:"connectionVersion"`
	CollectedAt       time.Time `json:"collectedAt"`
	ResultState       string    `json:"resultState"`
	EvidenceState     string    `json:"evidenceState"`
	AcceptanceState   string    `json:"acceptanceState"`
}
type TaskEvidencePage struct {
	Reference   TaskEvidenceRef `json:"reference"`
	Text        string          `json:"text"`
	Hash        string          `json:"hash"`
	Offset      int             `json:"offset"`
	NextOffset  int             `json:"nextOffset,omitempty"`
	Historical  bool            `json:"historical"`
	Truncated   bool            `json:"truncated"`
	StoredBytes int             `json:"storedBytes"`
	Notice      string          `json:"notice"`
}

func (e *Engine) referencedEvidence(ctx context.Context, session, source string, after uint64, limit int) ([]TaskEvidenceRef, []nativeEvidence, error) {
	c, err := e.superReadConfig(session)
	if err != nil || c.superRole != "worker" {
		return nil, nil, errSuperBinding
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, nil, err
	}
	refs := []TaskEvidenceRef{}
	evidence := []nativeEvidence{}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var link superTaskReferenceRow
			project := configSecurityProject(c)
			catalog, err := e.catalogReconciliationTx(ctx, tx, project, storeID, epoch)
			if err != nil {
				return err
			}
			if err := tx.First(&link, "task_id = ? AND source_task_id = ? AND project_id = ?", c.superTaskID, source, project).Error; err != nil {
				return errSuperBinding
			}
			var w superWorkerRow
			if err := tx.First(&w, "task_id = ? AND project_id = ? AND parent_worker_id = ''", source, project).Error; err != nil {
				return err
			}
			view, err := projectSuperTaskTx(tx, w.goalSession(), source)
			if err != nil {
				return err
			}
			if view.Revision != link.SourceRevision {
				return errSuperConflict
			}
			policy, err := loadSecurityPolicy(tx, project, storeID, epoch)
			if err != nil {
				return err
			}
			var rows []nativeEvidence
			// Catalog/control calls are task records, not observations of a
			// resource. Do not publish them or let their absent host identity
			// prevent retrieval of the actual versioned diagnostic evidence.
			if err := tx.Table("native_evidences AS e").Select("e.*").Joins("JOIN native_operations o ON o.id=e.operation_id AND o.session_id=e.session_id").Where("o.goal_id = ? AND o.project_id = ? AND o.store_id = ? AND o.recovery_epoch = ? AND e.id > ?", source, project, storeID, epoch, after).Where("o.resource_id <> '' AND o.resource_connection_revision > 0").Where("e.status IN ?", []string{"completed", "failed", "unknown", "not_executed"}).Order("e.id").Limit(limit).Scan(&rows).Error; err != nil {
				return err
			}
			for _, item := range rows {
				var op nativeOperation
				if err := tx.First(&op, "id = ? AND goal_id = ? AND session_id = ?", item.OperationID, source, w.goalSession()).Error; err != nil {
					return err
				}
				var attempt workExecutionAttempt
				if err := tx.First(&attempt, "id = ? AND goal_id = ? AND session_id = ? AND project_id = ? AND goal_revision = ?", op.AttemptID, source, w.goalSession(), project, op.GoalRevision).Error; err != nil {
					return errSuperBinding
				}
				if op.CallID == "" || op.CallID != item.CallID {
					return errSuperBinding
				}
				if !slices.Contains(policy.ResourceIDs, op.ResourceID) {
					return errSuperBinding
				}
				var resource securityResourceRevisionRow
				if err := tx.First(&resource, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ? AND state = 'ready'", project, op.ResourceID, storeID, epoch).Error; err != nil {
					return errSuperBinding
				}
				current := false
				for _, actual := range catalog.Resources {
					if actual.ID == op.ResourceID && actual.State == "ready" && actual.ConnectionRevision == op.ResourceConnectionRevision && actual.ConnectionDigest == resource.ConnectionDigest {
						current = true
					}
				}
				if !current || op.AttemptID == "" {
					return errSuperBinding
				}
				if op.ResourceConnectionRevision < 1 || resource.ConnectionRevision != op.ResourceConnectionRevision {
					return errors.New("superagent: evidence connection version is stale")
				}
				id := hash(js([]any{source, view.Revision, item.ID, op.ID, op.AttemptID, op.ResourceID, op.ResourceConnectionRevision, op.Status, op.ClosureState, op.OrphanState}))
				state := op.Status
				if op.OrphanState == "effects_unknown" || op.ClosureState == "effects_unknown" {
					state = "unknown"
				}
				refs = append(refs, TaskEvidenceRef{ID: id, TaskID: source, GoalRevision: op.GoalRevision, TaskRevision: view.Revision, AttemptID: op.AttemptID, OperationID: op.ID, EvidenceID: strconv.FormatUint(item.ID, 10), ResourceID: op.ResourceID, ConnectionVersion: op.ResourceConnectionRevision, CollectedAt: item.At, ResultState: state, EvidenceState: item.Status, AcceptanceState: view.AcceptanceState})
				evidence = append(evidence, item)
			}
			return nil
		})
	})
	return refs, evidence, err
}

func (e *Engine) ListReferencedTaskEvidence(ctx context.Context, session, source, after string, limit int) (map[string]any, error) {
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 {
		return nil, errSuperBinding
	}
	var cursor uint64
	var err error
	if after != "" {
		cursor, err = strconv.ParseUint(after, 10, 64)
		if err != nil {
			return nil, errSuperBinding
		}
	}
	refs, _, err := e.referencedEvidence(ctx, session, source, cursor, limit)
	if err != nil {
		return nil, err
	}
	next := ""
	if len(refs) == limit {
		next = refs[len(refs)-1].EvidenceID
	}
	return map[string]any{"items": refs, "nextCursor": next, "notice": "Historical evidence only. Unknown/failed results and acceptance state are preserved; these references confer no execution permission."}, nil
}

func (e *Engine) ReadReferencedTaskEvidence(ctx context.Context, session, source, evidenceID, referenceID string, offset, limit int) (TaskEvidencePage, error) {
	var out TaskEvidencePage
	id, err := strconv.ParseUint(evidenceID, 10, 64)
	if err != nil || id < 1 || offset < 0 || limit < 1 || limit > 2048 {
		return out, fmt.Errorf("historical read arguments: %w", errSuperBinding)
	}
	refs, rows, err := e.referencedEvidence(ctx, session, source, id-1, 1)
	if err != nil {
		return out, fmt.Errorf("historical read source: %w", err)
	}
	if len(refs) != 1 || refs[0].EvidenceID != evidenceID || refs[0].ID != referenceID {
		return out, fmt.Errorf("historical read reference: %w", errSuperBinding)
	}
	raw := rows[0].Data
	if err = e.checkSuperPayload(raw); err != nil {
		return out, err
	}
	if offset > len(raw) || offset < len(raw) && !utf8.RuneStart(raw[offset]) {
		return out, errSuperBinding
	}
	text := utf8Prefix(raw[offset:], limit)
	next := offset + len(text)
	truncated := next < len(raw)
	if !truncated {
		next = 0
	}
	return TaskEvidencePage{Reference: refs[0], Text: text, Hash: hash(raw), Offset: offset, NextOffset: next, Historical: true, Truncated: truncated, StoredBytes: len(raw), Notice: "Captured stored evidence only; source tools may have truncated their output. nextOffset pages the stored bytes and cannot recover unseen source bytes. Historical observations do not establish current health."}, nil
}

// Revalidate the original historical-read receipt during manual acceptance and
// final goal aggregation. A successful local read never imports a source pass,
// host observation time, execution owner or permit into the comparison task.
func currentReferencedTaskReadTx(tx *gorm.DB, op nativeOperation) (bool, error) {
	var page TaskEvidencePage
	if json.Unmarshal([]byte(op.Result), &page) != nil || !page.Historical || page.Reference.TaskID == op.GoalID {
		return false, nil
	}
	ref := page.Reference
	var link superTaskReferenceRow
	if err := tx.First(&link, "task_id = ? AND source_task_id = ? AND project_id = ?", op.GoalID, ref.TaskID, op.ProjectID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	var worker superWorkerRow
	if err := tx.First(&worker, "task_id = ? AND project_id = ?", ref.TaskID, op.ProjectID).Error; err != nil {
		return false, err
	}
	view, err := projectSuperTaskTx(tx, worker.goalSession(), ref.TaskID)
	if err != nil {
		return false, err
	}
	if view.Revision != link.SourceRevision || ref.TaskRevision != view.Revision {
		return false, nil
	}
	var proof nativeEvidence
	if err := tx.First(&proof, "id = ? AND operation_id = ? AND session_id = ?", ref.EvidenceID, ref.OperationID, worker.goalSession()).Error; err != nil {
		return false, err
	}
	var source nativeOperation
	if err := tx.First(&source, "id = ? AND session_id = ? AND goal_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", ref.OperationID, worker.goalSession(), ref.TaskID, op.ProjectID, op.StoreID, op.RecoveryEpoch).Error; err != nil {
		return false, err
	}
	state := source.Status
	if source.OrphanState == "effects_unknown" || source.ClosureState == "effects_unknown" {
		state = "unknown"
	}
	expected := hash(js([]any{ref.TaskID, view.Revision, proof.ID, source.ID, source.AttemptID, source.ResourceID, source.ResourceConnectionRevision, source.Status, source.ClosureState, source.OrphanState}))
	want := TaskEvidenceRef{ID: expected, TaskID: ref.TaskID, GoalRevision: source.GoalRevision, TaskRevision: view.Revision, AttemptID: source.AttemptID, OperationID: source.ID, EvidenceID: strconv.FormatUint(proof.ID, 10), ResourceID: source.ResourceID, ConnectionVersion: source.ResourceConnectionRevision, CollectedAt: proof.At, ResultState: state, EvidenceState: proof.Status, AcceptanceState: view.AcceptanceState}
	if js(ref) != js(want) || source.CallID == "" || source.CallID != proof.CallID || source.ResourceID == "" || page.Hash != hash(proof.Data) || page.StoredBytes != len(proof.Data) || page.Offset < 0 || page.Offset > len(proof.Data) || !strings.HasPrefix(proof.Data[page.Offset:], page.Text) {
		return false, nil
	}
	var resource securityResourceRevisionRow
	if err := tx.First(&resource, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ? AND state = 'ready'", op.ProjectID, ref.ResourceID, op.StoreID, op.RecoveryEpoch).Error; err != nil {
		return false, err
	}
	policy, err := loadSecurityPolicy(tx, op.ProjectID, op.StoreID, op.RecoveryEpoch)
	if err != nil {
		return false, err
	}
	return resource.ConnectionRevision == ref.ConnectionVersion && slices.Contains(policy.ResourceIDs, ref.ResourceID), nil
}
