package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type securityRecoveryReviewRow struct {
	RecoveryID                                     string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, LedgerIndexHash, State string
	Revision                                       int64
}

func (securityRecoveryReviewRow) TableName() string { return "security_recovery_reviews" }

type securityRecoveryImpactRow struct {
	ID                                                        string `gorm:"primaryKey"`
	RecoveryID                                                string `gorm:"index"`
	Source, SourceID, OperationID, RecordDigest, OperationRef string
	Descriptor, DescriptorDigest, ScopeState, ResourceIDs     string
	Revision                                                  int64
}

func (securityRecoveryImpactRow) TableName() string { return "security_recovery_impacts" }

type securityRecoveryResourceBlockRow struct {
	ID                                          string `gorm:"primaryKey"`
	RecoveryID, ImpactID, ProjectID, ResourceID string `gorm:"index"`
	ConnectionRevision                          int64
	ConnectionDigest, State, ProofRef           string
	Revision                                    int64
}

func (securityRecoveryResourceBlockRow) TableName() string {
	return "security_recovery_resource_blocks"
}

type securityRecoveryPolicyReviewRow struct {
	ID                                      string `gorm:"primaryKey"`
	RecoveryID, ProjectID                   string `gorm:"index"`
	SourceDigest                            string
	PriorPolicies                           string
	MaximumPriorRevision, ConfirmedRevision int64
	Confirmed                               bool
}

func (securityRecoveryPolicyReviewRow) TableName() string { return "security_recovery_policy_reviews" }

func securityRecoveryModels() []any {
	return []any{&securityRecoveryReviewRow{}, &securityRecoveryImpactRow{}, &securityRecoveryResourceBlockRow{}, &securityRecoveryPolicyReviewRow{}, &securityRecoveryWorkArchiveRow{}, &securityRecoveryLegacyReviewRow{}, &securityRecoveryReconciliationRow{}}
}

type SecurityRecoveryAction struct {
	ActorID          string `json:"-"` // Assigned by the authenticated host/CLI, never body.actor.
	ActionID         string `json:"actionId"`
	RecoveryID       string `json:"recoveryId"`
	RecoveryEpoch    string `json:"recoveryEpoch"`
	ExpectedRevision int64  `json:"expectedRevision"`
}

type SecurityRecoveryImpact struct {
	ID           string   `json:"id"`
	Source       string   `json:"source"`
	SourceID     string   `json:"sourceId"`
	OperationRef string   `json:"operationRef"`
	RecordDigest string   `json:"recordDigest"`
	ScopeState   string   `json:"scopeState"`
	ResourceIDs  []string `json:"resourceIds"`
	ProofMethod  string   `json:"proofMethod"`
}

type SecurityRecoveryPolicy struct {
	ProjectID            string                           `json:"projectId"`
	SourceDigest         string                           `json:"sourceDigest"`
	MaximumPriorRevision int64                            `json:"maximumPriorRevision"`
	ConfirmedRevision    int64                            `json:"confirmedRevision"`
	Confirmed            bool                             `json:"confirmed"`
	PriorPolicies        []SecurityRecoveryPriorPolicy    `json:"priorPolicies"`
	CatalogResources     []SecurityRecoveryPolicyResource `json:"catalogResources"`
}

type SecurityRecoveryPolicyResource struct {
	Resource             security.ResourceRevision `json:"resource"`
	Kind                 string                    `json:"kind"`
	RequiresConfirmation bool                      `json:"requiresConfirmation"`
}

type SecurityRecoveryPriorPolicy struct {
	Source string                 `json:"source"`
	Policy security.ProjectPolicy `json:"policy"`
}

type SecurityRecoveryReview struct {
	RecoveryID              string                                  `json:"recoveryId"`
	RecoveryEpoch           string                                  `json:"recoveryEpoch"`
	Revision                int64                                   `json:"revision"`
	State                   string                                  `json:"state"`
	Impacts                 []SecurityRecoveryImpact                `json:"impacts"`
	Policies                []SecurityRecoveryPolicy                `json:"policies"`
	WriteBlockedResourceIDs []string                                `json:"writeBlockedResourceIds"`
	ReadyForActivation      bool                                    `json:"readyForActivation"`
	ReviewComplete          bool                                    `json:"reviewComplete"`
	LegacyPolicies          []SecurityRecoveryLegacyPolicy          `json:"legacyPolicies"`
	Reconciliations         []SecurityRecoveryReconciliationReceipt `json:"reconciliations"`
}

func openSecurityRecoverySQL(path string) (*gorm.DB, *sql.DB, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !platform.Private(path, info) {
		return nil, nil, errors.New("security: canonical recovery database unavailable")
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, nil, err
	}
	raw.SetMaxOpenConns(1)
	if _, err = raw.Exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL"); err != nil {
		raw.Close()
		return nil, nil, err
	}
	db, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: raw}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		raw.Close()
		return nil, nil, err
	}
	return db, raw, nil
}

func initializeSecurityRecoveryReview(ctx context.Context, home string, journal securityRestoreJournal) error {
	if !validSecurityRestoreJournal(journal) {
		return errors.New("security: invalid recovery review identity")
	}
	root := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID)
	if err := verifyRecoveryCheckpointBindings(ctx, root, journal); err != nil {
		return err
	}
	db, raw, err := openSecurityRecoverySQL(filepath.Join(journal.After.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		return err
	}
	defer raw.Close()
	models := append(securityRecoveryModels(), &securityAuthorityEvent{}, &securityRuntimeModeRow{})
	models = append(models, securityPolicyModels()...)
	if err = db.WithContext(ctx).AutoMigrate(models...); err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var old securityRecoveryReviewRow
		if err := tx.First(&old, "recovery_id = ?", journal.After.RecoveryID).Error; err == nil {
			if old.StoreID != journal.After.StoreID || old.RecoveryEpoch != journal.After.RecoveryEpoch || old.LedgerIndexHash != journal.LedgerIndexHash {
				return security.ErrConflict
			}
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		row := securityRecoveryReviewRow{RecoveryID: journal.After.RecoveryID, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, LedgerIndexHash: journal.LedgerIndexHash, State: "review", Revision: 1}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		projects := map[string]bool{}
		for _, source := range []string{"preserved", "incoming"} {
			directory := filepath.Join(root, source)
			cp, err := VerifySecurityCheckpoint(ctx, directory)
			if err != nil {
				return err
			}
			sourceSQL, err := openSecurityReadOnlyMode(filepath.Join(directory, "adk", "sessions.sqlite"), true)
			if err != nil {
				return err
			}
			err = importRecoveryImpacts(ctx, tx, sourceSQL, row.RecoveryID, source, cp.ID)
			if err == nil {
				var sourceGORM *gorm.DB
				sourceGORM, err = gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: sourceSQL}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
				if err == nil {
					err = importRecoveryWorkArchives(ctx, tx, sourceGORM, row.RecoveryID, source, cp.ID)
				}
			}
			if err == nil {
				err = importRecoveryPolicyReviews(ctx, tx, sourceSQL, row.RecoveryID, source, projects)
			}
			if err == nil {
				err = importRecoveryLegacyPolicies(ctx, tx, sourceSQL, row.RecoveryID, source)
			}
			sourceSQL.Close()
			if err != nil {
				return err
			}
		}
		currentProjects, err := recoveryWebProjects(filepath.Join(filepath.Dir(journal.After.RuntimeRoot), "lake-web.sqlite"))
		if err != nil {
			return err
		}
		for _, project := range currentProjects {
			projects[project] = true
		}
		for project := range projects {
			id := hash(row.RecoveryID + "\x00policy\x00" + project)
			var existing securityRecoveryPolicyReviewRow
			if err = tx.First(&existing, "id = ?", id).Error; errors.Is(err, gorm.ErrRecordNotFound) {
				err = tx.Create(&securityRecoveryPolicyReviewRow{ID: id, RecoveryID: row.RecoveryID, ProjectID: project, SourceDigest: hash("no-prior-policy\x00" + project)}).Error
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
}

func recoveryWebProjects(path string) ([]string, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	db, err := openSecurityReadOnly(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var exists int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='projects'").Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, nil
	}
	rows, err := db.Query("SELECT id FROM projects ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		if !identifier.MatchString(id) {
			return nil, errors.New("security: invalid project identity in recovery catalog")
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func importRecoveryImpacts(ctx context.Context, tx *gorm.DB, source *sql.DB, recoveryID, sourceName, sourceID string) error {
	var exists int
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_operations'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return nil
	}
	columns, err := securityNativeOperationColumns(ctx, source)
	if err != nil {
		return err
	}
	unresolved := securityUnresolvedOperationPredicate(columns)
	selected := []string{}
	lengths := []string{}
	for _, field := range []string{"id", "status", "args_hash", "descriptor_digest", "security_descriptor", "orphan_state", "closure_state", "cancellation_state", "cancel_requested_at", "risk_resolved_at"} {
		if !columns[field] {
			continue
		}
		selected = append(selected, field)
		maximum := 4096
		if field == "security_descriptor" {
			maximum = 1 << 20
		}
		var oversized int
		if err := source.QueryRowContext(ctx, "SELECT count(*) FROM native_operations WHERE "+unresolved+" AND length(COALESCE("+field+",''))>?", maximum).Scan(&oversized); err != nil {
			return err
		}
		if oversized > 0 {
			return errors.New("security: oversized recovery impact metadata; keep gate closed")
		}
		lengths = append(lengths, "length(COALESCE("+field+",''))")
	}
	var metadataBytes int64
	if err := source.QueryRowContext(ctx, "SELECT COALESCE(sum("+strings.Join(lengths, "+")+"),0) FROM native_operations WHERE "+unresolved).Scan(&metadataBytes); err != nil {
		return err
	}
	if metadataBytes > 64<<20 {
		return errors.New("security: recovery impact metadata exceeds bounded review limit")
	}
	var count int
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM native_operations WHERE "+unresolved).Scan(&count); err != nil {
		return err
	}
	if count > 50000 {
		return errors.New("security: recovery impact review exceeds bounded limit; keep gate closed")
	}
	sourceGORM, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: source}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return err
	}
	var operations []nativeOperation
	if err = sourceGORM.WithContext(ctx).Select(selected).Where(unresolved).Order("id").Find(&operations).Error; err != nil {
		return err
	}
	for _, op := range operations {
		ref := securityRiskRef(sourceID, "operation", op.ID)
		impact := securityRecoveryImpactRow{ID: hash(recoveryID + "\x00" + sourceID + "\x00" + op.ID), RecoveryID: recoveryID, Source: sourceName, SourceID: sourceID, OperationID: op.ID, OperationRef: ref, RecordDigest: recoveryImpactRecordDigest(op), Descriptor: op.SecurityDescriptor, DescriptorDigest: op.DescriptorDigest, ScopeState: "unverified", ResourceIDs: "[]", Revision: 1}
		if err = tx.Create(&impact).Error; err != nil {
			return err
		}
	}
	return nil
}

func importRecoveryPolicyReviews(ctx context.Context, tx *gorm.DB, source *sql.DB, recoveryID, sourceName string, projects map[string]bool) error {
	var exists int
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='security_project_policies'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return nil
	}
	rows, err := source.QueryContext(ctx, "SELECT project_id,revision,data FROM security_project_policies ORDER BY project_id")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var project, data string
		var revision int64
		if err = rows.Scan(&project, &revision, &data); err != nil {
			return err
		}
		if !identifier.MatchString(project) || revision < 1 || revision == math.MaxInt64 {
			return errors.New("security: invalid prior policy identity")
		}
		projects[project] = true
		id := hash(recoveryID + "\x00policy\x00" + project)
		var old securityRecoveryPolicyReviewRow
		err = tx.First(&old, "id = ?", id).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			old = securityRecoveryPolicyReviewRow{ID: id, RecoveryID: recoveryID, ProjectID: project}
		} else if err != nil {
			return err
		}
		old.MaximumPriorRevision = max(old.MaximumPriorRevision, revision)
		var prior []SecurityRecoveryPriorPolicy
		if old.PriorPolicies != "" {
			if err = json.Unmarshal([]byte(old.PriorPolicies), &prior); err != nil {
				return err
			}
		}
		var policy security.ProjectPolicy
		if err = decodeSecurityJSON(data, &policy); err != nil || policy.ProjectID != project || policy.Revision != revision {
			return errors.New("security: unsupported prior policy data; keep recovery gate closed")
		}
		prior = append(prior, SecurityRecoveryPriorPolicy{Source: sourceName, Policy: policy})
		old.PriorPolicies = js(prior)
		old.SourceDigest = hash(old.SourceDigest + "\x00" + sourceName + "\x00" + fmt.Sprint(revision) + "\x00" + hash(data))
		if err = tx.Save(&old).Error; err != nil {
			return err
		}
	}
	return rows.Err()
}

func (h *SecurityHome) withSecurityRecoveryReview(ctx context.Context, fn func(*gorm.DB, securityRestoreJournal) error) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || !h.readOnly {
		return errors.New("security: recovery management requires a closed read-only owner")
	}
	control, err := ReadSecurityControl(h.Home)
	if err != nil {
		return err
	}
	if control != h.control || control.Gate != "closed" {
		return errors.New("security: recovery management epoch changed")
	}
	var journal securityRestoreJournal
	if err = privateSecurityRead(filepath.Join(h.Home, "security", "restore.pending.json"), &journal); err != nil {
		return err
	}
	if !validSecurityRestoreJournal(journal) || journal.After != control || journal.Stage != "confirmation_required" {
		return errors.New("security: recovery review is not ready")
	}
	if _, err = readRecoveryLedgerIndex(ctx, h.Home, journal); err != nil {
		return err
	}
	db, raw, err := openSecurityRecoverySQL(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		return err
	}
	defer raw.Close()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := fn(tx, journal); err != nil {
			return err
		}
		current, err := ReadSecurityControl(h.Home)
		if err != nil || current != control {
			return errors.New("security: recovery epoch changed before commit")
		}
		return nil
	})
}

func readSecurityRecoveryReview(tx *gorm.DB, journal securityRestoreJournal) (SecurityRecoveryReview, error) {
	var row securityRecoveryReviewRow
	if err := tx.First(&row, "recovery_id = ? AND store_id = ? AND recovery_epoch = ?", journal.After.RecoveryID, journal.After.StoreID, journal.After.RecoveryEpoch).Error; err != nil {
		return SecurityRecoveryReview{}, err
	}
	if row.LedgerIndexHash != journal.LedgerIndexHash {
		return SecurityRecoveryReview{}, security.ErrConflict
	}
	out := SecurityRecoveryReview{RecoveryID: row.RecoveryID, RecoveryEpoch: row.RecoveryEpoch, Revision: row.Revision, State: row.State, Impacts: []SecurityRecoveryImpact{}, Policies: []SecurityRecoveryPolicy{}, WriteBlockedResourceIDs: []string{}}
	var impacts []securityRecoveryImpactRow
	if err := tx.Where("recovery_id = ?", row.RecoveryID).Order("id").Find(&impacts).Error; err != nil {
		return out, err
	}
	ready := true
	for _, impact := range impacts {
		ids := []string{}
		if err := json.Unmarshal([]byte(impact.ResourceIDs), &ids); err != nil {
			return out, err
		}
		proof := "trusted_original_descriptor_required"
		if impact.ScopeState == "mapped" {
			proof = "frozen_descriptor_and_source_catalog"
		} else {
			ready = false
		}
		out.Impacts = append(out.Impacts, SecurityRecoveryImpact{ID: impact.ID, Source: impact.Source, SourceID: impact.SourceID, OperationRef: impact.OperationRef, RecordDigest: impact.RecordDigest, ScopeState: impact.ScopeState, ResourceIDs: ids, ProofMethod: proof})
	}
	var policies []securityRecoveryPolicyReviewRow
	if err := tx.Where("recovery_id = ?", row.RecoveryID).Order("project_id").Find(&policies).Error; err != nil {
		return out, err
	}
	for _, policy := range policies {
		prior := []SecurityRecoveryPriorPolicy{}
		if policy.PriorPolicies != "" {
			if err := json.Unmarshal([]byte(policy.PriorPolicies), &prior); err != nil {
				return out, err
			}
		}
		resources, err := recoveryPolicyCatalogResources(tx, journal, policy.ProjectID)
		if err != nil {
			return out, err
		}
		out.Policies = append(out.Policies, SecurityRecoveryPolicy{ProjectID: policy.ProjectID, SourceDigest: policy.SourceDigest, MaximumPriorRevision: policy.MaximumPriorRevision, ConfirmedRevision: policy.ConfirmedRevision, Confirmed: policy.Confirmed, PriorPolicies: prior, CatalogResources: resources})
		if !policy.Confirmed {
			ready = false
		}
	}
	var blocks []securityRecoveryResourceBlockRow
	if err := tx.Where("recovery_id = ? AND state = ?", row.RecoveryID, "blocked").Find(&blocks).Error; err != nil {
		return out, err
	}
	for _, block := range blocks {
		out.WriteBlockedResourceIDs = append(out.WriteBlockedResourceIDs, block.ResourceID)
	}
	slices.Sort(out.WriteBlockedResourceIDs)
	out.WriteBlockedResourceIDs = slices.Compact(out.WriteBlockedResourceIDs)
	// This is review readiness only. Actual entrypoint coverage/readers still
	// gate activation separately and cannot be asserted by this projection.
	out.ReviewComplete = ready
	out.ReadyForActivation = ready && SecurityEnforcementStatus().Ready
	if err := appendRecoveryLegacyReviews(tx, &out); err != nil {
		return out, err
	}
	var receipts []securityRecoveryReconciliationRow
	if tx.Migrator().HasTable(&securityRecoveryReconciliationRow{}) {
		if err := tx.Where("recovery_id = ?", row.RecoveryID).Order("at,id").Find(&receipts).Error; err != nil {
			return out, err
		}
	}
	out.Reconciliations = []SecurityRecoveryReconciliationReceipt{}
	for _, receipt := range receipts {
		out.Reconciliations = append(out.Reconciliations, SecurityRecoveryReconciliationReceipt{ID: receipt.ID, ImpactID: receipt.ImpactID, SourceID: receipt.SourceID, RecordDigest: receipt.RecordDigest, ResourceID: receipt.ResourceID, OperationID: receipt.ProofOperationID, TaskID: receipt.ProofTaskID, ProofDigest: receipt.ProofDigest, Actor: receipt.Actor, ActionID: receipt.ActionID, ClosedAttemptRef: recoveryClosedAttemptRef(receipt), At: receipt.At})
	}
	return out, nil
}

func (h *SecurityHome) SecurityRecoveryReview(ctx context.Context) (out SecurityRecoveryReview, err error) {
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		out, err = readSecurityRecoveryReview(tx, journal)
		return err
	})
	return out, err
}

func validRecoveryAction(a SecurityRecoveryAction, journal securityRestoreJournal) bool {
	return strings.TrimSpace(a.ActorID) != "" && len(a.ActorID) <= 256 && strings.TrimSpace(a.ActionID) != "" && len(a.ActionID) <= 256 && a.RecoveryID == journal.After.RecoveryID && a.RecoveryEpoch == journal.After.RecoveryEpoch && a.ExpectedRevision > 0
}

func recoveryActionBegin(tx *gorm.DB, journal securityRestoreJournal, a SecurityRecoveryAction, request string, replay any) (bool, error) {
	if !validRecoveryAction(a, journal) {
		return false, errSecurityAction
	}
	if repeated, err := securityActionReplay(tx, journal.After.StoreID, journal.After.RecoveryEpoch, a.ActorID, a.ActionID, request, replay); repeated || err != nil {
		return repeated, err
	}
	var row securityRecoveryReviewRow
	if err := tx.First(&row, "recovery_id = ? AND store_id = ? AND recovery_epoch = ? AND revision = ?", a.RecoveryID, journal.After.StoreID, journal.After.RecoveryEpoch, a.ExpectedRevision).Error; err != nil {
		return false, security.ErrConflict
	}
	if row.State != "review" || row.LedgerIndexHash != journal.LedgerIndexHash {
		return false, security.ErrConflict
	}
	return false, nil
}

func recoveryActionCommit(tx *gorm.DB, journal securityRestoreJournal, a SecurityRecoveryAction, kind, object, request string, now time.Time) (SecurityRecoveryReview, error) {
	changed := tx.Model(&securityRecoveryReviewRow{}).Where("recovery_id = ? AND revision = ? AND state = ?", a.RecoveryID, a.ExpectedRevision, "review").Update("revision", a.ExpectedRevision+1)
	if changed.Error != nil {
		return SecurityRecoveryReview{}, changed.Error
	}
	if changed.RowsAffected != 1 {
		return SecurityRecoveryReview{}, security.ErrConflict
	}
	out, err := readSecurityRecoveryReview(tx, journal)
	if err != nil {
		return out, err
	}
	err = securityActionRecord(tx, journal.After.StoreID, journal.After.RecoveryEpoch, a.ActorID, a.ActionID, kind, object, request, a.ExpectedRevision, out.Revision, out, now)
	return out, err
}

// CheckSecurityRecoveryWriteBlocks must run in every final dispatch transaction
// for mutating capabilities. It references preserved operations without changing
// their status; a successful different task cannot clear these blocks.
func CheckSecurityRecoveryWriteBlocks(tx *gorm.DB, resourceIDs []string) error {
	if !tx.Migrator().HasTable(&securityRecoveryResourceBlockRow{}) {
		return nil
	}
	var count int64
	query := tx.Model(&securityRecoveryResourceBlockRow{}).Where("state = ?", "blocked")
	if len(resourceIDs) > 0 {
		query = query.Where("resource_id IN ?", resourceIDs)
	}
	if err := query.Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrUnresolvedResourceEffect
	}
	return nil
}

func sortedRecoveryResources(resources []security.ResourceRevision) []string {
	ids := make([]string, 0, len(resources))
	for _, resource := range resources {
		ids = append(ids, resource.ID)
	}
	sort.Strings(ids)
	return ids
}

func recoveryClosedAttemptRef(receipt securityRecoveryReconciliationRow) string {
	if receipt.ClosedAttemptID == "" {
		return ""
	}
	return securityRiskRef(receipt.SourceID, "attempt", receipt.ClosedAttemptID)
}
