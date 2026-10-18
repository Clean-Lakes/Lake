package ai

// Missing risk on a legacy/custom repository record is conservative. Only the
// trusted policy can establish that a call is safe to sample again.
func SREOperationNeedsVerification(op SREOperation) bool {
	return op.Status == "unknown" && op.Risk != "readonly"
}

func SREOperationBlocksResume(op SREOperation) bool {
	return op.Status == "dispatched" || SREOperationNeedsVerification(op)
}

// A later successful sample can cover an earlier read timeout, but the original
// failed record remains in the audit trail. A report alone cannot fill the gap.
func sreReadCheckIncomplete(a SREStepAttempt) bool {
	pending := map[string]bool{}
	for _, op := range a.Operations {
		if op.Risk != "readonly" {
			continue
		}
		key := op.Digest
		if key == "" {
			key = hash(op.Call.Name + op.Call.Arguments)
		}
		if op.Status == "unknown" {
			pending[key] = true
		}
		if op.Status == "succeeded" {
			delete(pending, key)
		}
	}
	if len(pending) > 0 {
		return true
	}
	return false
}

func sreOperationBlockError(op SREOperation) error {
	if op.Status == "dispatched" {
		return sreError(409, "原操作仍在运行，请通过原句柄等待或读取结果；不会重复派发。")
	}
	return sreError(409, "变更操作结果不明，本轮没有恢复执行；请在待核实操作入口核实实际状态，不要重发或承诺正在继续。")
}

func (e *Engine) sreCallReadOnly(c Config, call Call) bool {
	if !sreTrackedCall(c, call) {
		return false
	}
	task, err := e.sreRepository.LoadSRETask(e.worker.parentID, c.sre.TaskID)
	if err != nil {
		return false
	}
	for _, a := range task.Attempts {
		if a.ID != c.sre.AttemptID {
			continue
		}
		for _, op := range a.Operations {
			if op.Call.ID == call.ID && op.Digest == hash(call.Name+call.Arguments) {
				return op.Risk == "readonly"
			}
		}
	}
	return false
}
