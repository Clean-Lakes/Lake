package ai

import (
	"errors"
)

func (e *Engine) scopedChildConfig(c Config, a map[string]any) (Config, error) {
	w := e.worker
	if w == nil {
		return c, nil
	}
	w.session.mu.Lock()
	current := w.session.state.Config
	remembered := append([]string(nil), w.session.state.ReferencedAssetIDs...)
	w.session.mu.Unlock()
	p, cp := DefaultPermissions(), DefaultPermissions()
	if c.Permissions != nil {
		p = *c.Permissions
	}
	if current.Permissions != nil {
		cp = *current.Permissions
	}
	p.SilentReadFiles = p.SilentReadFiles && cp.SilentReadFiles
	p.SilentReadSQL = p.SilentReadSQL && cp.SilentReadSQL
	p.DenyLocalExecution = p.DenyLocalExecution || cp.DenyLocalExecution
	p.BlockUnreferencedAssets = p.BlockUnreferencedAssets || cp.BlockUnreferencedAssets
	p.SilentWriteFiles = false
	p.SilentCommands = false
	p.SilentTerminalCreation = false
	if c.sre != nil && (c.sre.FullTools || c.sre.Role == SREExecutor) {
		p.SilentCommands = c.Permissions != nil && c.Permissions.SilentCommands && cp.SilentCommands
		p.SilentWriteFiles = c.Permissions != nil && c.Permissions.SilentWriteFiles && cp.SilentWriteFiles
		p.SilentTerminalCreation = c.Permissions != nil && c.Permissions.SilentTerminalCreation && cp.SilentTerminalCreation
	}
	c.Permissions = &p
	c.ReferencedAssets = append([]string(nil), w.assets...)
	ref := str(a["asset_ref"])
	if ref != "" {
		as, err := asset(c, ref)
		if err != nil {
			return c, err
		}
		found := false
		for _, id := range w.assets {
			found = found || id == as.ID
		}
		if !found {
			return c, errors.New("资源不在子任务范围内")
		}
		if _, err = asset(current, as.ID); err != nil {
			return c, errors.New("父会话资源授权已撤销")
		}
		if p.BlockUnreferencedAssets {
			allowed := false
			for _, id := range append(current.ReferencedAssets, remembered...) {
				allowed = allowed || id == as.ID
			}
			if !allowed {
				return c, errors.New("父会话已撤销此资源的引用授权")
			}
		}
		if p.DenyLocalExecution && (as.Kind == "local" || as.Kind == "database" && str(as.Settings["driver"]) == "sqlite") {
			return c, errors.New("当前会话禁止本机执行")
		}
	}
	return c, nil
}
