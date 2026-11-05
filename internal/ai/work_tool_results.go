package ai

import (
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// Tool-result contracts verify committed observations from the original attempt.
// They do not manufacture human verification or replace explicit business criteria.
func verifyWorkToolResultsTx(tx *gorm.DB, goal WorkGoal, stepID string, attempt workExecutionAttempt, operations []nativeOperation, allowed map[string]bool) (security.AcceptanceState, []security.CriterionResult, error) {
	step := goal.closure.Steps[stepID]
	state := security.AcceptanceInsufficient
	result := security.CriterionResult{State: state}
	if len(step.Criteria) != 1 || step.Criteria[0].Method != "tool_result" || step.Criteria[0].Target != goal.SessionID {
		return state, nil, nil
	}
	result.CriterionID = step.Criteria[0].ID
	now := time.Now().UTC()
	if len(operations) == 0 {
		return state, []security.CriterionResult{result}, nil
	}
	for _, op := range operations {
		if op.Status != "succeeded" || op.ProjectID != goal.closure.ProjectID || op.SessionID != goal.SessionID || op.GoalID != goal.ID || op.StepID != stepID || op.AttemptID != attempt.ID || op.SecurityTaskID != attempt.SecurityTaskID || op.RootTurnID != attempt.RootTurnID || op.OwnerID == "" || op.OwnerGeneration < 1 || op.GoalRevision != goal.closure.GoalRevision || op.PlanRevision != goal.closure.PlanRevision || op.StepRevision != step.Revision {
			return state, []security.CriterionResult{result}, nil
		}
		policy, err := loadSecurityPolicy(tx, goal.closure.ProjectID, op.StoreID, op.RecoveryEpoch)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return state, []security.CriterionResult{result}, nil
			}
			return state, nil, err
		}
		current, err := currentWorkOperationResourcesTx(tx, op)
		if err != nil {
			return state, nil, err
		}
		if !current {
			return state, []security.CriterionResult{result}, nil
		}
		var descriptor security.PreparedOperation
		if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil || descriptor.PolicyRevision != policy.Revision {
			return state, []security.CriterionResult{result}, nil
		}
		var proofs []nativeEvidence
		if err := tx.Where("operation_id = ? AND session_id = ? AND status = ?", op.ID, goal.SessionID, "completed").Find(&proofs).Error; err != nil {
			return state, nil, err
		}
		observed := false
		for _, proof := range proofs {
			id := strconv.FormatUint(proof.ID, 10)
			if allowed != nil && !allowed[id] || proof.At.Before(attempt.CreatedAt) || proof.At.After(now) || step.Criteria[0].MaxAgeSeconds > 0 && now.Sub(proof.At) > time.Duration(step.Criteria[0].MaxAgeSeconds)*time.Second || proof.CallID != op.CallID || proof.Tool != op.Tool {
				continue
			}
			if toolResultObserved(op.Tool, proof.Data) {
				current, err = currentWorkToolResultAuthorityTx(tx, descriptor, proof.Data)
				if err != nil {
					return state, nil, err
				}
				if !current {
					continue
				}
				observed = true
				result.EvidenceIDs = append(result.EvidenceIDs, id)
			}
		}
		if !observed {
			return state, []security.CriterionResult{result}, nil
		}
	}
	result.State = security.AcceptancePass
	return security.AcceptancePass, []security.CriterionResult{result}, nil
}

func currentWorkToolResultAuthorityTx(tx *gorm.DB, descriptor security.PreparedOperation, raw string) (bool, error) {
	if descriptor.Tool == "list_mcp_tools" && descriptor.MCPServerID != "" {
		// Discovery commits its own new catalog revision. Only that exact
		// observed catalog may replace the prepared revision during verification;
		// configuration, binding and credential checks still apply below.
		var result struct {
			Tools []map[string]any `json:"tools"`
		}
		if json.Unmarshal([]byte(raw), &result) != nil || result.Tools == nil {
			return false, nil
		}
		slices.SortFunc(result.Tools, func(a, b map[string]any) int { return strings.Compare(str(a["name"]), str(b["name"])) })
		var server securityMCPRevisionRow
		if err := tx.First(&server, "id = ? AND store_id = ? AND recovery_epoch = ?", descriptor.MCPServerID, descriptor.StoreID, descriptor.RecoveryEpoch).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			return false, err
		}
		if server.CatalogDigest != hash(js(result.Tools)) {
			return false, nil
		}
		descriptor.MCPCatalogRevision = server.CatalogRevision
	}
	return runningCatalogAuthorityValid(tx, descriptor, true)
}

func toolResultObserved(tool, raw string) bool {
	var data any
	if json.Unmarshal([]byte(raw), &data) != nil || data == nil {
		return false
	}
	switch value := data.(type) {
	case string:
		return strings.TrimSpace(value) != ""
	case map[string]any:
		if value["isError"] == true {
			return false
		}
		if tool == "call_mcp_tool" {
			if result, exists := value["structuredContent"]; exists && result != nil {
				return true
			}
			for _, block := range arr(value["content"]) {
				entry := obj(block)
				if str(entry["type"]) != "" && (str(entry["type"]) != "text" || strings.TrimSpace(str(entry["text"])) != "") {
					return true
				}
			}
			return false
		}
		return len(value) > 0
	default:
		return true
	}
}
