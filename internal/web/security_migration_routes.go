package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// securityMigrationRoute is management-only and must run after protect/auth,
// before the recovery-view allowlist. It creates no Engine or resource clients.
func (b *Server) securityMigrationRoute(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/security/status", "/api/security/recovery/status", "/api/security/recovery/ledger-index", "/api/security/recovery/review", "/api/security/recovery/reconcile-preview", "/api/security/recovery/reconcile", "/api/security/recovery/work-history", "/api/security/recovery/impact-map", "/api/security/recovery/policy-confirm", "/api/security/recovery/legacy-confirm", "/api/security/recovery/activate", "/api/security/enforce", "/api/security/shadow", "/api/security/recovery/confirm", "/api/security/checkpoint", "/api/security/restore":
	default:
		return false
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(http.StatusUnauthorized, "Authentication required")
	}
	if r.URL.Path == "/api/security/recovery/reconcile" || r.URL.Path == "/api/security/recovery/reconcile-preview" {
		if b.Engine == nil || b.securityRuntime == nil || b.securityRuntime.ReadOnlyView() {
			fail(409, "恢复门禁尚未激活；请先启动新纪元的受限核验任务")
		}
		switch r.URL.Path {
		case "/api/security/recovery/reconcile-preview":
			if r.Method != http.MethodGet {
				fail(405, "Method not allowed")
			}
			result, err := b.Engine.SecurityRecoveryReconciliationPreview(r.Context(), r.URL.Query().Get("impactId"), r.URL.Query().Get("resourceId"), r.URL.Query().Get("operationId"))
			aiFailure(err)
			reply(w, 200, result)
		case "/api/security/recovery/reconcile":
			if r.Method != http.MethodPost {
				fail(405, "Method not allowed")
			}
			var input ai.SecurityRecoveryReconciliation
			decoder := json.NewDecoder(strings.NewReader(jsonText(body(w, r, 1<<20))))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&input) != nil {
				fail(400, "Invalid typed reconciliation action")
			}
			input.Action.ActorID = "local-user"
			result, err := b.Engine.ReconcileSecurityRecoveryImpact(r.Context(), input)
			aiFailure(err)
			reply(w, 200, result)
		}
		return true
	}

	if r.Method == http.MethodPost && (r.URL.Path == "/api/security/recovery/impact-map" || r.URL.Path == "/api/security/recovery/policy-confirm" || r.URL.Path == "/api/security/recovery/legacy-confirm" || r.URL.Path == "/api/security/recovery/activate") {
		if b.securityRuntime == nil || !b.securityRuntime.ReadOnlyView() {
			fail(409, "仅关闭门禁的恢复管理允许此动作")
		}
		data := body(w, r, 1<<20)
		decode := func(target any) {
			decoder := json.NewDecoder(strings.NewReader(jsonText(data)))
			decoder.DisallowUnknownFields()
			if decoder.Decode(target) != nil {
				fail(400, "Invalid typed recovery action")
			}
		}
		var result ai.SecurityRecoveryReview
		var err error
		switch r.URL.Path {
		case "/api/security/recovery/impact-map":
			var input ai.SecurityRecoveryMapping
			decode(&input)
			input.Action.ActorID = "local-user"
			result, err = b.securityRuntime.MapSecurityRecoveryImpact(r.Context(), input)
		case "/api/security/recovery/policy-confirm":
			var input ai.SecurityRecoveryPolicyConfirmation
			decode(&input)
			input.Action.ActorID = "local-user"
			result, err = b.securityRuntime.ConfirmSecurityRecoveryPolicy(r.Context(), input)
		case "/api/security/recovery/legacy-confirm":
			var input ai.SecurityRecoveryLegacyConfirmation
			decode(&input)
			input.Action.ActorID = "local-user"
			result, err = b.securityRuntime.ConfirmSecurityRecoveryLegacyPolicy(r.Context(), input)
		case "/api/security/recovery/activate":
			var input ai.SecurityRecoveryAction
			decode(&input)
			input.ActorID = "local-user"
			result, err = b.securityRuntime.ActivateSecurityRecovery(r.Context(), input)
		}
		aiFailure(err)
		reply(w, 200, result)
		return true
	}
	if r.Method != http.MethodGet {
		fail(http.StatusConflict, "安全管理变更需要停服后使用 lake security CLI；当前接口只读，不修改授权或打开恢复门禁")
	}
	switch r.URL.Path {
	case "/api/security/status":
		control, err := ai.ReadSecurityControl(b.options.Home)
		aiFailure(err)
		reply(w, http.StatusOK, Object{"storeID": control.StoreID, "recoveryEpoch": control.RecoveryEpoch, "gate": control.Gate, "storeReady": control.StoreReady, "recoveryID": control.RecoveryID, "schemaVersion": security.SchemaVersion, "readerVersion": security.ReaderVersion, "enforcement": ai.SecurityEnforcementStatus()})
		return true
	case "/api/security/recovery/review":
		if b.securityRuntime == nil {
			fail(503, "Recovery runtime unavailable")
		}
		var review ai.SecurityRecoveryReview
		var err error
		if !b.securityRuntime.ReadOnlyView() && b.Engine != nil {
			review, err = b.Engine.ActiveSecurityRecoveryReview(r.Context())
		} else {
			review, err = b.securityRuntime.SecurityRecoveryReview(r.Context())
		}
		aiFailure(err)
		reply(w, 200, review)
		return true
	case "/api/security/recovery/work-history":
		if b.securityRuntime == nil {
			fail(503, "Recovery runtime unavailable")
		}
		limit := 100
		if raw := r.URL.Query().Get("limit"); raw != "" {
			var err error
			limit, err = strconv.Atoi(raw)
			if err != nil || limit < 1 || limit > 1000 {
				fail(400, "Invalid history limit")
			}
		}
		history, err := b.securityRuntime.SecurityRecoveryWorkHistory(r.Context(), r.URL.Query().Get("sessionId"), limit)
		aiFailure(err)
		reply(w, 200, history)
		return true
	case "/api/security/recovery/status":
		result, err := ai.RecoveryPending(b.options.Home)
		if errors.Is(err, os.ErrNotExist) {
			reply(w, http.StatusOK, Object{"pending": false})
			return true
		}
		aiFailure(err)
		reply(w, http.StatusOK, Object{"pending": true, "recovery": result})
		return true
	case "/api/security/recovery/ledger-index":
		index, err := ai.ReadRecoveryLedgerIndex(r.Context(), b.options.Home)
		if errors.Is(err, os.ErrNotExist) {
			fail(http.StatusNotFound, "没有待核实的备份恢复")
		}
		aiFailure(err)
		reply(w, http.StatusOK, index)
		return true
	}
	return false
}
