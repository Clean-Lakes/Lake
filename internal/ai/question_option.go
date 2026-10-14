package ai

import (
	"bytes"
	"encoding/json"
	"errors"
)

// QuestionOption accepts legacy string labels while exposing descriptions to clients.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
}

func (o *QuestionOption) UnmarshalJSON(data []byte) error {
	var label string
	if json.Unmarshal(data, &label) == nil {
		*o = QuestionOption{Label: label}
		return nil
	}
	type option QuestionOption
	var decoded option
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return errors.New("invalid question option")
	}
	*o = QuestionOption(decoded)
	return nil
}
