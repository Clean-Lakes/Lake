package ai

// Keep small, factual handoff data ahead of potentially large raw sources. A
// long first attempt must not hide later results or saved recovery links.
func sreHandoffOverview(t SRETask) map[string]any {
	attempts, recoveries := []map[string]any{}, []map[string]any{}
	registered, valid := 0, 0
	for _, a := range t.Attempts {
		for _, r := range a.ReadRecoveries {
			registered++
			verified := pilotReadRecoveryValid(a, r)
			if verified {
				valid++
			}
			recoveries = append(recoveries, map[string]any{"stepId": a.StepID, "failedOperationId": r.FailedOperationID, "replacementOperationIds": r.ReplacementOperationIDs, "valid": verified, "reason": utf8Prefix(r.Reason, 180)})
		}
	}
	for i := len(t.Attempts) - 1; i >= 0 && len(attempts) < 12; i-- {
		a := t.Attempts[i]
		attempts = append(attempts, map[string]any{"stepId": a.StepID, "attemptId": a.ID, "planRunId": a.PlanRunID, "status": a.Status, "resultPreview": utf8Prefix(a.Result, 240), "evidenceCount": len(a.Evidence), "operationCount": len(a.Operations), "readRecoveryCount": len(a.ReadRecoveries)})
	}
	recoveries = recoveries[max(0, len(recoveries)-8):]
	overview := map[string]any{"attemptCount": len(t.Attempts), "recentAttemptsNewestFirst": attempts, "registeredReadRecoveryCount": registered, "validReadRecoveryCount": valid, "recentReadRecoveries": recoveries, "notice": "Task-wide recorded audit, including earlier attempts; a saved read replacement is not business recovery. Do not say no read-recovery record exists when the count is nonzero. Previews are bounded, never complete sources or authority. Use sre_team_read to read authorized evidence before resolving any discrepancy."}
	for len(js(overview)) > 7500 {
		if len(attempts) > 0 {
			attempts = attempts[:len(attempts)-1]
			overview["recentAttemptsNewestFirst"] = attempts
		} else if len(recoveries) > 0 {
			recoveries = recoveries[1:]
			overview["recentReadRecoveries"] = recoveries
		} else {
			break
		}
	}
	return overview
}

// Output cadence follows actual plan steps; it does not limit specialist tools,
// evidence retention or independent investigation.
func sreOutputInstruction(step SREPlanStep) string {
	if step.Kind == "summarize" {
		return "\nConversation output: this is the task's FINAL SUMMARY. Consolidate prior findings once in one or two short conversational paragraphs, normally about 120..220 Chinese characters or equivalent. Lead directly with the actual outcome, then decisive evidence, an unresolved risk or next action only when useful. Do not add numbered sections, a mandatory point list, metric tables, bold paragraphs or repeated conclusions. Keep blockers and unverified recovery explicit; brevity cannot hide missing evidence. Cite the few decisive recorded sources. Expand when the user explicitly requests a detailed report; preserve required structured report fields. For every comparison, distinguish a recorded baseline from the current observation and from an expected healthy value. Only calculate a change or say unchanged when both baseline and current values of that same field are actually recorded. A missing baseline is unknown, never zero, false, healthy or unchanged. Carry material unknowns from the specialists into the final conclusion; the opening sentence and table must agree with those limitations. Independently rereading an identical current snapshot verifies that snapshot, not its change relative to an absent historical baseline."
	}
	return "\nConversation output: this is a NODE CHECKPOINT, not the final task summary. On completion, give only 1..3 short sentences (normally within about 120 Chinese characters or equivalent): this node's result, a material exception or blocker, and what remains if relevant. Do not write a task-wide report, a full checklist, repeated scope/permission declarations or a multi-section metric table. For investigator JSON, keep summary this short and retain supporting facts/evidence/unknowns in the structured fields; the UI can expand those details. During execution, publish team updates only for a new finding, blocker, changed status or concrete peer request, normally 1..2 sentences. Do not republish the checkpoint as a team update immediately before finishing. Full task synthesis belongs to the terminal summarize step."
}
