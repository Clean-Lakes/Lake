package ai

import "sort"

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
