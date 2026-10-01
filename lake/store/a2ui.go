package store

import (
	"encoding/json"
	"errors"
	"github.com/cloudwego/eino/lake/agent"
	"regexp"
)

var uiSensitiveKey = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)`)

func SanitizeUISnapshot(v agent.UISnapshot) (agent.UISnapshot, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal(b, &v); err != nil {
		return v, err
	}
	if err = v.Validate(); err != nil {
		return v, err
	}
	cleanID, _ := ExecutionPreview(v.SurfaceID, 96)
	if cleanID != v.SurfaceID {
		return v, errors.New("面板ID包含敏感内容")
	}
	var clean func(any) any
	clean = func(value any) any {
		switch x := value.(type) {
		case string:
			t, _ := ExecutionPreview(x, 16*1024)
			return t
		case []any:
			for i, c := range x {
				x[i] = clean(c)
			}
			return x
		case map[string]any:
			for k, c := range x {
				if uiSensitiveKey.MatchString(k) {
					x[k] = "[redacted]"
				} else {
					x[k] = clean(c)
				}
			}
			return x
		default:
			return value
		}
	}
	for _, c := range v.Components {
		for k, value := range c {
			if k == "id" || k == "component" {
				if text, ok := value.(string); ok {
					safe, _ := ExecutionPreview(text, 96)
					if safe != text {
						return v, errors.New("组件ID包含敏感内容")
					}
				}
				continue
			}
			c[k] = clean(value)
		}
	}
	v.Data = clean(v.Data).(map[string]any)
	return v, v.Validate()
}
