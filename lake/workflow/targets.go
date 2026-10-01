package workflow

import (
	"context"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/lake/store"
)

// CheckTargets validates resource identities against Lake's data layer.
// A nil anchors map permits any registered resource in the named lake.
func CheckTargets(ctx context.Context, s *store.Store, lakeName string, def Definition, anchors map[string]struct{}, allowSlots bool) error {
	seen := make(map[string]bool)
	for _, step := range def.Steps {
		if strings.HasPrefix(step.Resource, "$") {
			if allowSlots {
				continue
			}
			return fmt.Errorf("步骤 %s 尚未绑定运行目标 %q", step.ID, step.Resource)
		}
		if seen[step.Resource] {
			continue
		}
		seen[step.Resource] = true
		resource, err := s.ResolveResource(ctx, lakeName+"/"+step.Resource)
		if err != nil {
			return fmt.Errorf("步骤 %s 的资源 %q: %w", step.ID, step.Resource, err)
		}
		if anchors != nil {
			if _, ok := anchors[resource.ID]; !ok {
				return fmt.Errorf("步骤 %s 的资源 %q 不在本次对话的冻结范围内", step.ID, step.Resource)
			}
		}
	}
	return nil
}
