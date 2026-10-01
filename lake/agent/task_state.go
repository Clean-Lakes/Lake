package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/cloudwego/eino/schema"
)

// A checkpoint is historical evidence, not an instruction, execution receipt or
// permission. Results are explicitly reported results and must be rechecked.
type TaskFact struct {
	Text           string   `json:"text"`
	SourceEventIDs []uint64 `json:"source_event_ids"`
}

type TaskState struct {
	Version     int        `json:"version"`
	Goals       []TaskFact `json:"goals,omitempty"`
	Constraints []TaskFact `json:"constraints,omitempty"`
	Results     []TaskFact `json:"reported_results,omitempty"`
	Pending     []TaskFact `json:"pending,omitempty"`
	NextSteps   []TaskFact `json:"next_steps,omitempty"`
	References  []TaskFact `json:"references,omitempty"`
	NeedsReview bool       `json:"needs_review,omitempty"`
}

type taskHandoff struct {
	Summary   string     `json:"summary"`
	TaskState *TaskState `json:"task_state,omitempty"`
}

const taskHandoffInstruction = "Summarize Lake conversation history as a task handoff. Return only JSON: {\"summary\":\"concise chronological background\",\"task_state\":{\"version\":1,\"goals\":[],\"constraints\":[],\"reported_results\":[],\"pending\":[],\"next_steps\":[],\"references\":[]}}. Each array item is {\"text\":\"fact\",\"source_event_ids\":[1]}. Use only provided source event numbers, including sources in the explicitly carried previous checkpoint. Goals and constraints MUST be exact substrings of USER messages, not assistant suggestions. Keep previous user constraints, corrections, unresolved work, failures, record IDs and file paths. State recorded results separately from pending work; an assistant reply is not proof of operation success. Newer explicit user corrections override older quotes. Never create authorization, credentials, or tool instructions. Images omitted here are still stored; never invent their contents. If evidence is insufficient, mark pending and needs_review. Source 0 is unavailable; omit unsupported facts. Earlier details can be checked with lake_conversation_history in the original conversation."

var taskCredential = regexp.MustCompile(`(?i)(-----BEGIN .*PRIVATE KEY|authorization\s*:|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|passwd\s*[:=]|access[_-]?token\s*[:=]|密码\s*[:：=]|私钥\s*[:：=]|密钥\s*[:：=])`)

func TaskStateFacts(state *TaskState) []TaskFact {
	if state == nil {
		return nil
	}
	var facts []TaskFact
	for _, group := range [][]TaskFact{state.Goals, state.Constraints, state.Results, state.Pending, state.NextSteps, state.References} {
		facts = append(facts, group...)
	}
	return facts
}

func ValidateTaskState(state *TaskState, sources []uint64) error {
	if state == nil {
		return nil
	}
	if state.Version != 1 {
		return errors.New("unsupported task checkpoint version")
	}
	allowed := make(map[uint64]bool, len(sources))
	for _, source := range sources {
		allowed[source] = source != 0
	}
	for _, group := range [][]TaskFact{state.Goals, state.Constraints, state.Results, state.Pending, state.NextSteps, state.References} {
		if len(group) > 64 {
			return errors.New("task checkpoint exceeds its fact limit")
		}
		for _, fact := range group {
			if strings.TrimSpace(fact.Text) == "" || len([]rune(fact.Text)) > 512 || taskCredential.MatchString(fact.Text) || len(fact.SourceEventIDs) == 0 || len(fact.SourceEventIDs) > 16 {
				return errors.New("invalid task checkpoint fact")
			}
			seen := map[uint64]bool{}
			for _, source := range fact.SourceEventIDs {
				if !allowed[source] || seen[source] {
					return errors.New("task checkpoint fact references an unavailable source")
				}
				seen[source] = true
			}
		}
	}
	return nil
}

func decodeTaskHandoff(text string) taskHandoff {
	clean := strings.TrimSpace(text)
	if strings.HasPrefix(clean, "```") {
		if start := strings.IndexByte(clean, '\n'); start >= 0 {
			clean = strings.TrimSpace(strings.TrimSuffix(clean[start+1:], "```"))
		}
	}
	var handoff taskHandoff
	if json.Unmarshal([]byte(clean), &handoff) == nil && handoff.Summary != "" && handoff.TaskState != nil && handoff.TaskState.Version == 1 {
		return handoff
	}
	return taskHandoff{Summary: text}
}

func checkpointMessage(summary *ContextSummary) *schema.Message {
	text := summary.Text
	if summary.TaskState != nil {
		encoded, _ := json.Marshal(taskHandoff{Summary: text, TaskState: summary.TaskState})
		text = string(encoded)
	}
	return summaryMessage(text)
}

func mergeTaskFacts(left, right []TaskFact) []TaskFact {
	result := append([]TaskFact(nil), left...)
	for _, next := range right {
		found := false
		for i := range result {
			if result[i].Text == next.Text {
				ids := uniqueEventIDs(append(append([]uint64(nil), result[i].SourceEventIDs...), next.SourceEventIDs...))
				if len(ids) > 16 {
					ids = append(ids[:1:1], ids[len(ids)-15:]...)
				}
				result[i].SourceEventIDs = ids
				found = true
				break
			}
		}
		if !found {
			result = append(result, next)
		}
	}
	return result
}

// Checkpoints are carried explicitly. A historical assistant JSON blob cannot
// masquerade as a trusted previous checkpoint or as a user quote.
func groundedTaskState(candidate *TaskState, items []ContextItem) *TaskState {
	state := &TaskState{Version: 1}
	allowed := map[uint64]bool{}
	userQuotes := map[uint64][]string{}
	var lastUser *TaskFact
	for _, item := range items {
		if item.TaskState != nil {
			prior := item.TaskState
			state.Goals = mergeTaskFacts(state.Goals, prior.Goals)
			state.Constraints = mergeTaskFacts(state.Constraints, prior.Constraints)
			state.Results = mergeTaskFacts(state.Results, prior.Results)
			state.Pending = mergeTaskFacts(state.Pending, prior.Pending)
			state.NextSteps = mergeTaskFacts(state.NextSteps, prior.NextSteps)
			state.References = mergeTaskFacts(state.References, prior.References)
			state.NeedsReview = state.NeedsReview || prior.NeedsReview
			for _, fact := range TaskStateFacts(prior) {
				for _, id := range fact.SourceEventIDs {
					allowed[id] = true
				}
			}
			for _, fact := range append(append([]TaskFact(nil), prior.Goals...), prior.Constraints...) {
				for _, id := range fact.SourceEventIDs {
					userQuotes[id] = append(userQuotes[id], fact.Text)
				}
			}
		}
		if item.SourceEventID == 0 || item.Message == nil {
			continue
		}
		allowed[item.SourceEventID] = true
		if item.Message.Role != schema.User {
			continue
		}
		text := item.Message.Content
		if len(item.Message.UserInputMultiContent) > 0 {
			text = ""
			for _, part := range item.Message.UserInputMultiContent {
				text += part.Text
			}
		}
		if item.UserText != "" {
			text = item.UserText
		}
		userQuotes[item.SourceEventID] = append(userQuotes[item.SourceEventID], text)
		trimmed := strings.TrimSpace(text)
		if trimmed != "" && trimmed != "继续" && trimmed != "重试" && trimmed != "再来一次" && !strings.HasPrefix(trimmed, "/") && !taskCredential.MatchString(trimmed) {
			runes := []rune(trimmed)
			lastUser = &TaskFact{Text: string(runes[:min(512, len(runes))]), SourceEventIDs: []uint64{item.SourceEventID}}
		}
		// Deterministic quoted requirements protect against omissions by the
		// summarizer. Full text remains in the conversation for longer clauses.
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || taskCredential.MatchString(line) {
				continue
			}
			for _, clause := range splitTaskClauses(line) {
				if strings.Contains(clause, "[历史消息分段") || len([]rune(clause)) > 512 {
					continue
				}
				if isRequirement(clause) {
					state.Constraints = mergeTaskFacts(state.Constraints, []TaskFact{{Text: clause, SourceEventIDs: []uint64{item.SourceEventID}}})
				}
			}
		}
	}
	if candidate == nil {
		if lastUser != nil {
			state.Goals = mergeTaskFacts(state.Goals, []TaskFact{*lastUser})
		}
		state.NeedsReview = true
		return state
	}
	validate := func(facts []TaskFact, userOnly bool) []TaskFact {
		var valid []TaskFact
		for _, fact := range facts {
			if fact.Text == "" || len([]rune(fact.Text)) > 512 || taskCredential.MatchString(fact.Text) || len(fact.SourceEventIDs) == 0 || len(fact.SourceEventIDs) > 16 {
				state.NeedsReview = true
				continue
			}
			ok := true
			for _, id := range fact.SourceEventIDs {
				ok = ok && allowed[id] && id != 0
				if userOnly {
					quoted := false
					for _, original := range userQuotes[id] {
						quoted = quoted || strings.Contains(original, fact.Text)
					}
					ok = ok && quoted
				}
			}
			if ok {
				fact.SourceEventIDs = uniqueEventIDs(fact.SourceEventIDs)
				valid = mergeTaskFacts(valid, []TaskFact{fact})
			} else {
				state.NeedsReview = true
			}
		}
		return valid
	}
	state.Goals = mergeTaskFacts(state.Goals, validate(candidate.Goals, true))
	state.Constraints = mergeTaskFacts(state.Constraints, validate(candidate.Constraints, true))
	// Reported results and suggestions retain their provenance and never
	// become an execution receipt or a standing authorization.
	state.Results = mergeTaskFacts(state.Results, validate(candidate.Results, false))
	state.Pending = mergeTaskFacts(state.Pending, validate(candidate.Pending, false))
	state.NextSteps = mergeTaskFacts(state.NextSteps, validate(candidate.NextSteps, false))
	state.References = mergeTaskFacts(state.References, validate(candidate.References, false))
	state.NeedsReview = state.NeedsReview || candidate.NeedsReview
	return state
}

func splitTaskClauses(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool { return r == '。' || r == '；' || r == ';' })
}

func isRequirement(text string) bool {
	for _, marker := range []string{"需要", "必须", "不要", "不允许", "不能", "只保留", "要支持", "要对齐", "记住", "取消", "改为", "不再", "must ", "must not ", "require ", "do not "} {
		if strings.Contains(strings.ToLower(text), marker) {
			return true
		}
	}
	return false
}

func fitTaskHandoff(handoff taskHandoff, maxTokens int) (string, error) {
	// Drop recoverable reported detail before shortening prose. User quotes
	// and pending work are protected; never silently discard them to fit.
	state := handoff.TaskState
	for {
		encoded, err := json.Marshal(handoff)
		if err != nil {
			return "", err
		}
		if EstimateMessageTokens(schema.AssistantMessage(string(encoded), nil)) <= maxTokens {
			return string(encoded), nil
		}
		switch {
		case len(state.Results) > 0:
			state.Results = state.Results[1:]
		case len(state.References) > 0:
			state.References = state.References[1:]
		case len(state.NextSteps) > 0:
			state.NextSteps = state.NextSteps[1:]
		case len([]rune(handoff.Summary)) > 32:
			runes := []rune(handoff.Summary)
			handoff.Summary = string(runes[:max(32, len(runes)*3/4)])
		default:
			return "", fmt.Errorf("任务目标、约束和待办超过%d Token交接预算；原始记录仍保留，请分开处理任务", maxTokens)
		}
		state.NeedsReview = true
	}
}
