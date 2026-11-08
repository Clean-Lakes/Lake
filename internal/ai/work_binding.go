package ai

import "errors"

// Resource snapshots describe task references, never an execution allowlist.
// A foreground shell selection is not evidence of the new goal's target. Prefer
// explicit aliases; otherwise use trusted directory scope or calls made since
// the latest user message. Never mine older turns/remembered approvals for targets.
func requestedWorkBindings(c Config, scope *TargetScope, history []Message, refs []string) ([]WorkBinding, error) {
	explicit := len(refs) > 0
	if !explicit && scope != nil && (scope.NeedsClarification || len(scope.ResourceIDs) == 0) {
		// A goal can exist before its resources are discovered. This does not
		// resolve the target or authorize I/O through an ambiguous directory.
		return nil, nil
	}
	if !explicit {
		if scope != nil {
			refs = append(refs, scope.ResourceIDs...)
		} else {
			for i := len(history) - 1; i >= 0; i-- {
				message := history[i]
				if message.Role == "user" {
					break
				}
				if message.Role != "assistant" {
					continue
				}
				for _, call := range message.Calls {
					if workToolName(call.Name) {
						continue
					}
					a, err := args(call)
					if err == nil && str(a["asset_ref"]) != "" {
						refs = append(refs, str(a["asset_ref"]))
					}
				}
			}
		}
	}
	bindings := []WorkBinding{}
	seen := map[string]bool{}
	for _, ref := range refs {
		resource, err := asset(c, ref)
		if err != nil {
			return nil, err
		}
		if explicit && ref != assetAlias(resource.ID) {
			return nil, errors.New("work_begin 使用 list_assets 返回的资源别名")
		}
		if scope != nil && !scopeAllows(scope, resource.ID) {
			return nil, errors.New("工作目标超出当前目录范围")
		}
		if c.Permissions != nil && c.Permissions.BlockUnreferencedAssets {
			allowed := false
			for _, approved := range c.ReferencedAssets {
				if approved == resource.ID {
					allowed = true
				}
			}
			if !allowed {
				return nil, errors.New("请先引用工作目标资源")
			}
		}
		if seen[resource.ID] {
			continue
		}
		seen[resource.ID] = true
		selected := c
		selected.Runtime = resource.Kind
		selected.AssetRef = resource.ID
		// Only a matching host selection may donate its terminal/container binding.
		if c.AssetRef != resource.ID || resource.Kind == "kubernetes" {
			selected.TerminalID = ""
			selected.Container = ""
		}
		bindings = append(bindings, workBinding(selected))
	}

	return bindings, nil
}

// Record the validated operation target as well: a model may omit asset_refs
// when creating its bookkeeping. Only approved/in-scope resource access reaches
// this point, and the caller never donates a different foreground terminal.
func (e *Engine) recordWorkResource(s *session, c Config, resourceID string) error {
	if resourceID == "" {
		return nil
	}
	s.mu.Lock()
	goalID, id := s.state.WorkGoalID, s.state.View.Session
	s.mu.Unlock()
	if goalID == "" {
		return nil
	}
	row, g, err := e.workRow(id, goalID)
	if err != nil {
		return err
	}
	if workTerminal(g.Status) {
		return nil
	}
	bindings, err := requestedWorkBindings(c, c.targetScope, nil, []string{assetAlias(resourceID)})
	if err != nil {
		return err
	}
	if !mergeWorkResources(&g, bindings) {
		return nil
	}
	row.superFence = c.superAssignment
	return e.writeWorkGoal(&row, &g, false)
}

// Preserve each distinct resource identity as historical metadata. A legacy
// single binding joins the history; adding a resource never retargets an old op.
func mergeWorkResources(g *WorkGoal, candidates []WorkBinding) bool {
	changed := false
	appendSnapshot := func(candidate WorkBinding) {
		if candidate.AssetRef == "" {
			return
		}
		for _, old := range g.ResourceBindings {
			if old.AssetRef == candidate.AssetRef && old.ResourceIdentity == candidate.ResourceIdentity {
				return
			}
		}
		g.ResourceBindings = append(g.ResourceBindings, candidate)
		changed = true
	}
	appendSnapshot(g.Binding)
	for _, candidate := range candidates {
		appendSnapshot(candidate)
	}
	if changed {
		g.Binding = WorkBinding{}
		if len(g.ResourceBindings) == 1 {
			g.Binding = g.ResourceBindings[0]
		}
	}
	return changed
}
