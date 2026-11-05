package security

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// ObservationSourceDigest binds the verifier to the reviewed tool and exact
// canonical parameters. A constant SELECT or echoed success message cannot
// substitute for the actual reviewed observation query.
func ObservationSourceDigest(tool, argumentsDigest, resourceID string, connectionRevision int64) string {
	if _, ok := LookupTool(tool); !ok || !isDigest(argumentsDigest) || resourceID == "" || connectionRevision < 1 {
		return ""
	}
	raw, _ := json.Marshal(struct {
		Version                           int
		Tool, ArgumentsDigest, ResourceID string
		ConnectionRevision                int64
	}{1, tool, argumentsDigest, resourceID, connectionRevision})
	return ContentDigest(raw)
}

const VerifierVersion = "lake-acceptance/1"

type AcceptanceState string

const (
	AcceptancePass         AcceptanceState = "pass"
	AcceptanceFail         AcceptanceState = "fail"
	AcceptanceInsufficient AcceptanceState = "insufficient"
)

// Criteria are versioned before dispatch. They can only use registered typed
// comparisons against committed evidence, never model-provided scripts.
type AcceptanceCriterion struct {
	ID                 string          `json:"id"`
	Method             string          `json:"method"`
	Target             string          `json:"target"`
	TargetKind         TargetKind      `json:"targetKind,omitempty"`
	ConnectionRevision int64           `json:"connectionRevision"`
	SourceDigest       string          `json:"sourceDigest"`
	Pointer            string          `json:"pointer,omitempty"`
	Expected           json.RawMessage `json:"expected,omitempty"`
	MaxAgeSeconds      int64           `json:"maxAgeSeconds,omitempty"`
}

type ClosureBinding struct {
	ProjectID, SessionID, GoalID, StepID     string
	GoalRevision, PlanRevision, StepRevision int64
}

type Evidence struct {
	ID, OperationID, AttemptID, Target, Status string
	ConnectionRevision                         int64
	SourceDigest                               string
	Binding                                    ClosureBinding
	ObservedAt                                 time.Time
	Data                                       json.RawMessage
}

type CriterionResult struct {
	CriterionID string          `json:"criterionId"`
	State       AcceptanceState `json:"state"`
	EvidenceIDs []string        `json:"evidenceIds,omitempty"`
}

type ClosureAttempt struct {
	ID                  string
	Binding             ClosureBinding
	State, ClosureState string
}

type StepVerification struct {
	Binding   ClosureBinding
	AttemptID string
	Criteria  []AcceptanceCriterion
	Evidence  []Evidence
	// Unresolved is read from the authoritative operation/owner ledger in the
	// same transaction that commits acceptance, not supplied by the model.
	Unresolved bool
	Now        time.Time
}

func ValidateCriteria(criteria []AcceptanceCriterion) error {
	if len(criteria) == 0 || len(criteria) > 64 {
		return errors.New("acceptance criteria required")
	}
	seen := map[string]bool{}
	for _, c := range criteria {
		if strings.TrimSpace(c.ID) == "" || len(c.ID) > 128 || seen[c.ID] || c.Target == "" || !isDigest(c.SourceDigest) || c.MaxAgeSeconds < 0 || c.MaxAgeSeconds > 365*24*60*60 {
			return errors.New("invalid acceptance criterion")
		}
		seen[c.ID] = true
		if c.Method == "tool_result" {
			if c.TargetKind != TargetSession || c.ConnectionRevision != 0 || len(c.Expected) != 0 || c.Pointer != "" {
				return errors.New("invalid tool result criterion")
			}
			continue
		}
		if c.Method == "human_verified" {
			if c.TargetKind != TargetSession && c.TargetKind != TargetProject && c.TargetKind != TargetResource {
				return errors.New("invalid human verification target")
			}
			if c.TargetKind == TargetResource && c.ConnectionRevision < 1 {
				return errors.New("human verification resource revision required")
			}
			continue
		}
		if c.ConnectionRevision < 1 || c.TargetKind != "" && c.TargetKind != TargetResource {
			return errors.New("observation resource binding required")
		}
		switch c.Method {
		case "json_equal":
			if !json.Valid(c.Expected) {
				return errors.New("invalid acceptance expected value")
			}
		case "operation_succeeded":
		case "text_nonempty":
			if len(c.Expected) > 0 && string(c.Expected) != "null" {
				return errors.New("nonempty observation accepts no expected literal")
			}
		case "json_type":
			var expected string
			if json.Unmarshal(c.Expected, &expected) != nil {
				return errors.New("invalid observation type")
			}
			switch expected {
			case "object", "array", "number", "string", "boolean", "null":
			default:
				return errors.New("invalid observation type")
			}
		default:
			return errors.New("unregistered acceptance method")
		}
		if c.Pointer != "" && !strings.HasPrefix(c.Pointer, "/") {
			return errors.New("invalid evidence pointer")
		}
	}
	return nil
}

// VerifyStep is pure. The caller must obtain evidence and unresolved state from
// storage, then CAS the goal/step/progress versions when persisting its result.
func VerifyStep(in StepVerification) (AcceptanceState, []CriterionResult) {
	if ValidateCriteria(in.Criteria) != nil || in.Now.IsZero() || in.AttemptID == "" || in.Binding.GoalID == "" || in.Binding.StepID == "" || in.Binding.GoalRevision < 1 || in.Binding.PlanRevision < 1 || in.Binding.StepRevision < 1 {
		return AcceptanceInsufficient, nil
	}
	state := AcceptancePass
	results := make([]CriterionResult, 0, len(in.Criteria))
	for _, c := range in.Criteria {
		r := CriterionResult{CriterionID: c.ID, State: AcceptanceInsufficient}
		var newest time.Time
		for _, e := range in.Evidence {
			if e.ID == "" || e.OperationID == "" || e.Binding != in.Binding || e.AttemptID != in.AttemptID || e.Target != c.Target || e.ConnectionRevision != c.ConnectionRevision || e.SourceDigest != c.SourceDigest || e.Status != "succeeded" || e.ObservedAt.IsZero() || e.ObservedAt.After(in.Now) || c.MaxAgeSeconds > 0 && in.Now.Sub(e.ObservedAt) > time.Duration(c.MaxAgeSeconds)*time.Second {
				continue
			}
			if e.ObservedAt.Before(newest) {
				continue
			}
			if e.ObservedAt.After(newest) {
				r.State, r.EvidenceIDs, newest = AcceptanceInsufficient, nil, e.ObservedAt
			}
			matched := c.Method == "operation_succeeded"
			if c.Method == "json_equal" {
				value, ok := jsonPointer(e.Data, c.Pointer)
				if !ok {
					continue
				}
				var expected any
				if decodeJSON(c.Expected, &expected) != nil {
					continue
				}
				left, _ := json.Marshal(value)
				right, _ := json.Marshal(expected)
				matched = string(left) == string(right)
			}
			if c.Method == "text_nonempty" || c.Method == "json_type" {
				value, ok := jsonPointer(e.Data, c.Pointer)
				if !ok {
					continue
				}
				if c.Method == "text_nonempty" {
					text, ok := value.(string)
					matched = ok && strings.TrimSpace(text) != ""
				} else {
					actual := "null"
					switch value.(type) {
					case map[string]any:
						actual = "object"
					case []any:
						actual = "array"
					case json.Number:
						actual = "number"
					case string:
						actual = "string"
					case bool:
						actual = "boolean"
					}
					var expected string
					_ = json.Unmarshal(c.Expected, &expected)
					matched = actual == expected
				}
			}
			if matched && r.State != AcceptanceFail {
				r.State = AcceptancePass
				r.EvidenceIDs = append(r.EvidenceIDs, e.ID)
			} else {
				r.State = AcceptanceFail
				r.EvidenceIDs = nil
			}
		}
		results = append(results, r)
		if r.State == AcceptanceFail {
			state = AcceptanceFail
		} else if r.State == AcceptanceInsufficient && state != AcceptanceFail {
			state = AcceptanceInsufficient
		}
	}
	if in.Unresolved {
		state = AcceptanceInsufficient
	}
	return state, results
}

func decodeJSON(raw []byte, dst any) error {
	if !json.Valid(raw) {
		return errors.New("invalid evidence JSON")
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	return d.Decode(dst)
}

func jsonPointer(raw []byte, pointer string) (any, bool) {
	var value any
	if decodeJSON(raw, &value) != nil {
		return nil, false
	}
	if pointer == "" {
		return value, true
	}
	for _, key := range strings.Split(pointer[1:], "/") {
		for i := 0; i < len(key); i++ {
			if key[i] == '~' {
				if i+1 >= len(key) || (key[i+1] != '0' && key[i+1] != '1') {
					return nil, false
				}
				i++
			}
		}
		key = strings.ReplaceAll(strings.ReplaceAll(key, "~1", "/"), "~0", "~")
		switch object := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = object[key]
			if !ok {
				return nil, false
			}
		case []any:
			i, err := strconv.Atoi(key)
			if err != nil || i < 0 || i >= len(object) || strconv.Itoa(i) != key {
				return nil, false
			}
			value = object[i]
		default:
			return nil, false
		}
	}
	return value, true
}

type GoalStepAcceptance struct {
	ID        string
	Required  bool
	DependsOn []string
	State     AcceptanceState
	Binding   ClosureBinding
}

func VerifyGoal(binding ClosureBinding, steps []GoalStepAcceptance, unresolved bool) AcceptanceState {
	if unresolved || binding.GoalID == "" || binding.GoalRevision < 1 || binding.PlanRevision < 1 || len(steps) == 0 {
		return AcceptanceInsufficient
	}
	byID := map[string]GoalStepAcceptance{}
	for _, step := range steps {
		if step.ID == "" || step.Binding.StepID != step.ID || step.Binding.StepRevision < 1 || step.Binding.GoalID != binding.GoalID || step.Binding.SessionID != binding.SessionID || step.Binding.ProjectID != binding.ProjectID || step.Binding.GoalRevision != binding.GoalRevision || step.Binding.PlanRevision != binding.PlanRevision {
			return AcceptanceInsufficient
		}
		if _, duplicate := byID[step.ID]; duplicate {
			return AcceptanceInsufficient
		}
		byID[step.ID] = step
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(id string) bool {
		if visiting[id] {
			return false
		}
		if visited[id] {
			return true
		}
		step, exists := byID[id]
		if !exists || step.State != AcceptancePass {
			return false
		}
		visiting[id] = true
		for _, dep := range step.DependsOn {
			if !visit(dep) {
				return false
			}
		}
		visiting[id], visited[id] = false, true
		return true
	}
	required := false
	for _, step := range steps {
		if step.Required && !visit(step.ID) {
			return AcceptanceInsufficient
		}
		required = required || step.Required
	}
	if !required {
		return AcceptanceInsufficient
	}
	return AcceptancePass
}

// Coverage cannot erase execution history or reconcile unknown side effects.
func CanCover(failed, replacement ClosureAttempt, acceptance AcceptanceState, contractEqual bool, unresolved bool) bool {
	if unresolved || !contractEqual || acceptance != AcceptancePass || failed.ID == "" || failed.ID == replacement.ID || replacement.State != "succeeded" {
		return false
	}
	if failed.State != "failed" && failed.State != "not_executed" && failed.ClosureState != "reconciled" {
		return false
	}
	a, b := failed.Binding, replacement.Binding
	return a.SessionID != "" && a.GoalID != "" && a.StepID != "" && a.GoalRevision > 0 && a.PlanRevision > 0 && b.PlanRevision > 0 && a.StepRevision > 0 && a.ProjectID == b.ProjectID && a.SessionID == b.SessionID && a.GoalID == b.GoalID && a.StepID == b.StepID && a.GoalRevision == b.GoalRevision && a.StepRevision == b.StepRevision
}
