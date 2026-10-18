package ai

// Output cadence follows actual plan steps; it does not limit specialist tools,
// evidence retention or independent investigation.
func sreOutputInstruction(step SREPlanStep) string {
	if step.Kind == "summarize" {
		return "\nConversation output: this is the task's FINAL SUMMARY. Consolidate prior findings once in one or two short conversational paragraphs, normally about 120..220 Chinese characters or equivalent. Lead directly with the actual outcome, then decisive evidence, an unresolved risk or next action only when useful. Do not add numbered sections, a mandatory point list, metric tables, bold paragraphs or repeated conclusions. Keep blockers and unverified recovery explicit; brevity cannot hide missing evidence. Cite the few decisive recorded sources. Expand when the user explicitly requests a detailed report; preserve required structured report fields."
	}
	return "\nConversation output: this is a NODE CHECKPOINT, not the final task summary. On completion, give only 1..3 short sentences (normally within about 120 Chinese characters or equivalent): this node's result, a material exception or blocker, and what remains if relevant. Do not write a task-wide report, a full checklist, repeated scope/permission declarations or a multi-section metric table. For investigator JSON, keep summary this short and retain supporting facts/evidence/unknowns in the structured fields; the UI can expand those details. During execution, publish team updates only for a new finding, blocker, changed status or concrete peer request, normally 1..2 sentences. Do not republish the checkpoint as a team update immediately before finishing. Full task synthesis belongs to the terminal summarize step."
}
