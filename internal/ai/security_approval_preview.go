package ai

import (
	"errors"
	"fmt"
	"strings"
)

// Existing clients render before/after as plain reviewable operation text.
// Top-level resources would instead select the unrelated import-table view.
func securityOperationApprovalPreview(c Config, p *SecurityPreparedOperation, target string) (map[string]any, error) {
	op := p.descriptor
	before := fmt.Sprintf("目标：%s\n操作：%s\n能力：%s\n资源范围：%s\n参数边界：%s", target, op.Tool, strings.Join(op.Capabilities, ", "), js(securityCatalogResources(op.Resources)), js(op.Scope))
	after := ""
	if p.command != nil {
		compiled := p.command
		after = fmt.Sprintf("受控命令：%s\n执行程序：%s\n参数：%s\n工作目录：%s\n固定环境：%s", op.CommandProfileID, compiled.Executable(), js(compiled.Arguments()), compiled.Directory(), js(compiled.Environment()))
	} else {
		after = "精确操作参数：" + js(p.executionArgs)
	}
	before, after = redact(before, c), redact(after, c)
	if len(before)+len(after) > 30000 {
		return nil, errors.New("security: exact operation is too large for a complete approval preview")
	}
	return map[string]any{"before": before, "after": after}, nil
}
