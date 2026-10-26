package ai

import (
	"errors"
	"sort"
	"strings"
)

// Operation IDs and prose are presentation. Compare the actual calls and their
// prerequisite graph, so relabeling the same batch does not create a new choice.
func pilotDirectionSignature(direction PilotDirection) string {
	byID := map[string]string{}
	rows := make([]string, 0, len(direction.Operations))
	for _, operation := range direction.Operations {
		deps := make([]string, 0, len(operation.DependsOn))
		for _, id := range operation.DependsOn {
			deps = append(deps, byID[id])
		}
		sort.Strings(deps)
		key := hash(pilotFingerprint(operation.Tool, operation.Arguments) + js(deps))
		byID[operation.ID] = key
		rows = append(rows, key)
	}
	sort.Strings(rows)
	return hash(js(rows))
}

func pilotDistinctDirections(directions []PilotDirection) []PilotDirection {
	seen := map[string]int{}
	result := make([]PilotDirection, 0, len(directions))
	for _, direction := range directions {
		key := pilotDirectionSignature(direction)
		if index, ok := seen[key]; ok {
			// Prefer the recommended presentation while keeping a single choice.
			if direction.Recommended {
				result[index] = direction
			}
			continue
		}
		seen[key] = len(result)
		result = append(result, direction)
	}
	return result
}

// Only new human decisions need alternatives; continuation batches never enter
// this check. Do not force invented commands when only one method is safe.
func pilotChoiceDiversityError(choice *PilotChoice) error {
	if len(choice.SingleDirectionReason) > 1000 {
		return errors.New("single_direction_reason must be at most 1000 bytes")
	}
	if len(choice.Directions) == 1 && strings.TrimSpace(choice.SingleDirectionReason) == "" {
		return errors.New("Before asking the user, provide 2..4 distinct step-level strategies with different useful methods or sources, not renamed identical commands. If the user's fixed method or an observed safety constraint truly rules out alternatives, supply single_direction_reason explaining that constraint. Do not ask once per file or retry; continue an already selected purpose with its original ID, title and reason")
	}
	return nil
}
