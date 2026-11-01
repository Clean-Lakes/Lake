package ai

import (
	"context"
	"errors"
	"path/filepath"
)

// SecurityRecoveryLedgerIndex references original immutable operation ledgers;
// it is not another execution ledger and cannot authorize retries or remove a
// resource block. Its safe bounded projection retains explicit truncation.
type SecurityRecoveryLedgerIndex struct {
	FormatVersion         int                 `json:"formatVersion"`
	RecoveryID            string              `json:"recoveryID"`
	StoreID               string              `json:"storeID"`
	RecoveryEpoch         string              `json:"recoveryEpoch"`
	PreservedManifestHash string              `json:"preservedManifestHash"`
	IncomingManifestHash  string              `json:"incomingManifestHash"`
	ResourceMapping       string              `json:"resourceMapping"`
	Stores                []SecurityRiskStore `json:"stores"`
}

func verifyRecoveryCheckpointBindings(ctx context.Context, root string, journal securityRestoreJournal) error {
	for _, binding := range []struct{ path, digest, store, epoch string }{
		{filepath.Join(root, "preserved"), journal.PreservedManifestHash, journal.Before.StoreID, journal.Before.RecoveryEpoch},
		{filepath.Join(root, "incoming"), journal.IncomingManifestHash, journal.After.StoreID, journal.After.RecoveryEpoch},
	} {
		cp, err := VerifySecurityCheckpoint(ctx, binding.path)
		if err != nil {
			return err
		}
		digest, err := checkpointManifestHash(binding.path)
		if err != nil || binding.digest == "" || digest != binding.digest || cp.StoreID != binding.store || cp.RecoveryEpoch != binding.epoch {
			return errors.New("security: recovery checkpoint binding changed")
		}
	}
	return nil
}

func writeRecoveryLedgerIndex(ctx context.Context, root string, journal securityRestoreJournal) error {
	if err := verifyRecoveryCheckpointBindings(ctx, root, journal); err != nil {
		return err
	}
	index := SecurityRecoveryLedgerIndex{FormatVersion: 1, RecoveryID: journal.After.RecoveryID, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, PreservedManifestHash: journal.PreservedManifestHash, IncomingManifestHash: journal.IncomingManifestHash, ResourceMapping: "unverified", Stores: []SecurityRiskStore{}}
	for _, view := range []string{"preserved", "incoming"} {
		directory := filepath.Join(root, view)
		cp, err := VerifySecurityCheckpoint(ctx, directory)
		if err != nil {
			return err
		}
		db, err := openSecurityReadOnlyMode(filepath.Join(directory, "adk", "sessions.sqlite"), true)
		if err != nil {
			return err
		}
		summary, err := inspectSecurityRiskStore(ctx, db, cp.ID, view, 1000)
		db.Close()
		if err != nil {
			return err
		}
		index.Stores = append(index.Stores, summary)
	}
	return writeSecurityJSON(filepath.Join(root, "ledger-index.json"), index)
}

func readRecoveryLedgerIndex(ctx context.Context, home string, journal securityRestoreJournal) (SecurityRecoveryLedgerIndex, error) {
	var index SecurityRecoveryLedgerIndex
	if !validSecurityRestoreJournal(journal) {
		return index, errors.New("security: invalid recovery journal")
	}
	root := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID)
	if journal.Stage != "confirmation_required" || journal.LedgerIndexHash == "" {
		return index, errors.New("security: recovery ledger index not yet complete")
	}
	if err := verifyRecoveryCheckpointBindings(ctx, root, journal); err != nil {
		return index, err
	}
	digest, err := hashSecurityArchive(filepath.Join(root, "ledger-index.json"))
	if err != nil || digest != journal.LedgerIndexHash {
		return index, errors.New("security: recovery ledger index changed")
	}
	if err = privateSecurityRead(filepath.Join(root, "ledger-index.json"), &index); err != nil {
		return index, err
	}
	if index.FormatVersion != 1 || index.RecoveryID != journal.After.RecoveryID || index.StoreID != journal.After.StoreID || index.RecoveryEpoch != journal.After.RecoveryEpoch || index.PreservedManifestHash != journal.PreservedManifestHash || index.IncomingManifestHash != journal.IncomingManifestHash || index.ResourceMapping != "unverified" || len(index.Stores) != 2 {
		return index, errors.New("security: recovery ledger identity mismatch")
	}
	return index, nil
}

// ReadRecoveryLedgerIndex only reads local, verified snapshots. All identifiers
// that originate in legacy operation metadata are represented as hashes.
func ReadRecoveryLedgerIndex(ctx context.Context, home string) (SecurityRecoveryLedgerIndex, error) {
	var journal securityRestoreJournal
	if err := privateSecurityRead(filepath.Join(home, "security", "restore.pending.json"), &journal); err != nil {
		return SecurityRecoveryLedgerIndex{}, err
	}
	control, err := ReadSecurityControl(home)
	if err != nil {
		return SecurityRecoveryLedgerIndex{}, err
	}
	if !validSecurityRestoreJournal(journal) || (control != journal.After || control.Gate != "closed") && !activatedRecoveryControl(home, control, journal) {
		return SecurityRecoveryLedgerIndex{}, errors.New("security: recovery control mismatch")
	}
	index, err := readRecoveryLedgerIndex(ctx, home, journal)
	if err != nil {
		return index, err
	}
	current, err := ReadSecurityControl(home)
	if err != nil || current != control {
		return SecurityRecoveryLedgerIndex{}, errors.New("security: recovery identity changed during inspection")
	}
	return index, nil
}
