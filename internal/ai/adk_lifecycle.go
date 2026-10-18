package ai

import "errors"

func (e *Engine) admitRuntime() (func(), error) {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	if e.runtimeClosed {
		return nil, errors.New("Agent 服务正在关闭")
	}
	e.runs.Add(1)
	return e.runs.Done, nil
}
