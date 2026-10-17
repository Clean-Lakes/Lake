package ai

// Output cadence follows actual plan steps; it does not limit specialist tools,
// evidence retention or independent investigation.
func sreOutputInstruction(step SREPlanStep) string {
	if step.Kind == "summarize" {
		return "\nConversation output: this is the task's FINAL SUMMARY. Consolidate prior node findings once. Lead with the outcome, then 3..5 short points covering material findings, unresolved risks and next action; normally stay within about 300 Chinese characters (or equivalent). Do not repeat every metric, command, timestamp or specialist report. Cite the few decisive recorded sources; keep uncertainty and unverified recovery explicit. Expand only when the user explicitly requested a detailed report."
	}
	return "\nConversation output: this is a NODE CHECKPOINT, not the final task summary. On completion, give only 1..3 short sentences (normally within about 120 Chinese characters or equivalent): this node's result, a material exception or blocker, and what remains if relevant. Do not write a task-wide report, a full checklist, repeated scope/permission declarations or a multi-section metric table. For investigator JSON, keep summary this short and retain supporting facts/evidence/unknowns in the structured fields; the UI can expand those details. During execution, publish team updates only for a new finding, blocker, changed status or concrete peer request, normally 1..2 sentences. Do not republish the checkpoint as a team update immediately before finishing. Full task synthesis belongs to the terminal summarize step."
}
