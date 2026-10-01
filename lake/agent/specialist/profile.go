// Package specialist runs delegated Lake agents within an intersected scope.
package specialist

import (
	"errors"
	"regexp"

	"github.com/cloudwego/eino/lake/agent"
)

var profileName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Profile describes a specialist's model, bounded tool set, turn budget and
// requested project/resource scope. Tool implementations must also enforce
// their own path and resource checks immediately before execution.
type Profile struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Instruction string         `json:"instruction"`
	Model       string         `json:"model"`
	Tools       []string       `json:"tools"`
	MaxTurns    int            `json:"max_turns"`
	Scope       agent.RunScope `json:"scope"`
}

type Prepared struct {
	Profile
	Scope agent.RunScope `json:"scope"`
}

func Prepare(parent agent.RunScope, profile Profile) (Prepared, error) {
	if !profileName.MatchString(profile.Name) || profile.Description == "" || profile.Instruction == "" || profile.Model == "" || profile.MaxTurns < 1 || profile.MaxTurns > 32 || len(profile.Tools) == 0 || len(profile.Tools) > 64 || profile.Scope.AllTools {
		return Prepared{}, errors.New("专员配置无效")
	}
	seen := make(map[string]bool, len(profile.Tools))
	for _, name := range profile.Tools {
		if !profileName.MatchString(name) || seen[name] {
			return Prepared{}, errors.New("专员工具白名单无效")
		}
		seen[name] = true
	}
	requested := profile.Scope
	requested.ToolNames = append([]string(nil), profile.Tools...)
	requested.AllTools = false
	derived, err := parent.Intersect(requested)
	if err != nil {
		return Prepared{}, err
	}
	if len(derived.ToolNames) == 0 {
		return Prepared{}, errors.New("专员无可用工具")
	}
	return Prepared{Profile: profile, Scope: derived}, nil
}
