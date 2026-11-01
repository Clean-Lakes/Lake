package security

type ReasonCode string

const (
	ReasonAllowed                    ReasonCode = "ALLOWED"
	ReasonInvalidOperation           ReasonCode = "INVALID_OPERATION"
	ReasonUnregisteredTool           ReasonCode = "UNREGISTERED_TOOL"
	ReasonUnverifiableEffect         ReasonCode = "UNVERIFIABLE_EFFECT"
	ReasonGoalBindingRequired        ReasonCode = "GOAL_BINDING_REQUIRED"
	ReasonStepNotReady               ReasonCode = "STEP_NOT_READY"
	ReasonTaskNotActive              ReasonCode = "TASK_NOT_ACTIVE"
	ReasonTaskEnded                  ReasonCode = "TASK_ENDED"
	ReasonRecoveryRequired           ReasonCode = "RECOVERY_CONFIRMATION_REQUIRED"
	ReasonOperationStale             ReasonCode = "OPERATION_STALE"
	ReasonOrphanedExecution          ReasonCode = "ORPHANED_EXECUTION"
	ReasonSideEffectUnresolved       ReasonCode = "SIDE_EFFECT_UNRESOLVED"
	ReasonTargetOutsideBoundary      ReasonCode = "TARGET_OUTSIDE_BOUNDARY"
	ReasonLocalExecutionDenied       ReasonCode = "LOCAL_EXECUTION_DENIED"
	ReasonCapabilityDenied           ReasonCode = "CAPABILITY_DENIED"
	ReasonApprovalRequired           ReasonCode = "APPROVAL_REQUIRED"
	ReasonTaskScopeExtensionRequired ReasonCode = "TASK_SCOPE_EXTENSION_REQUIRED"
)
