package ai

import (
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

type AssetDirectory struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Path        []string `json:"path"`
	ResourceIDs []string `json:"resourceIds"`
}

// TargetScope is supplied by the trusted UI backend, never by a model tool call.
// Ambiguous or empty directory scopes allow discovery but prohibit execution.
type TargetScope struct {
	DirectoryIDs       []string `json:"directoryIds"`
	Paths              []string `json:"paths"`
	ResourceIDs        []string `json:"resourceIds"`
	NeedsClarification bool     `json:"needsClarification,omitempty"`
}

func cloneTargetScope(scope *TargetScope) *TargetScope {
	if scope == nil {
		return nil
	}
	copy := *scope
	copy.DirectoryIDs = append([]string{}, scope.DirectoryIDs...)
	copy.Paths = append([]string{}, scope.Paths...)
	copy.ResourceIDs = append([]string{}, scope.ResourceIDs...)
	return &copy
}
func (e *Engine) TargetScope(id string) (*TargetScope, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneTargetScope(s.state.TargetScope), nil
}
func compactDirectoryText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || strings.ContainsRune("\"'`“”‘’「」【】", r) {
			return -1
		}
		return unicode.ToLower(r)
	}, s)
}

var directoryLatin = regexp.MustCompile(`[a-z0-9]+`)

// Keep the Chinese words and Latin tokens exact while tolerating their order:
// 新k8s集群 and k8s新集群 have the same key; 新 and 旧 remain different.
func DirectoryNameKey(s string) string {
	s = compactDirectoryText(s)
	parts := strings.Split(strings.ReplaceAll(s, "\\", "/"), "/")
	for i, part := range parts {
		latin := directoryLatin.FindAllString(part, -1)
		sort.Strings(latin)
		parts[i] = directoryLatin.ReplaceAllString(part, "") + "|" + strings.Join(latin, ",")
	}
	return strings.Join(parts, "/")
}
func DirectoryNameMentioned(message, name string) bool {
	name = compactDirectoryText(name)
	if name == "" {
		return false
	}
	// Very short names need an explicit directory marker, quote or @ reference.
	if len([]rune(name)) < 3 {
		for _, suffix := range []string{"目录", "文件夹", "分组", "环境", "集群", "节点", "主机", "下面", "下的", "里的"} {
			if directoryLiteralMention(message, name+suffix) {
				return true
			}
		}
		return directoryLiteralMention(message, "@"+name)
	}
	if directoryLiteralMention(message, name) {
		return true
	}
	latin := directoryLatin.FindAllString(name, -1)
	if len(latin) != 1 {
		return false
	}
	han := []rune(directoryLatin.ReplaceAllString(name, ""))
	if len(han) == 0 {
		return false
	}
	for i := 0; i <= len(han); i++ {
		if directoryLiteralMention(message, string(han[:i])+latin[0]+string(han[i:])) {
			return true
		}
	}
	return false
}

func directoryLiteralMention(message, name string) bool {
	parts := []string{}
	for _, r := range name {
		parts = append(parts, regexp.QuoteMeta(string(r)))
	}
	// Preserve word/path boundaries while tolerating spaces inside a name.
	// A host or filesystem path containing the same word is not a folder selection.
	pattern := `(?i)(^|[^-a-z0-9_./\\非不无])` + strings.Join(parts, `[\s\p{Z}]*`) + `($|[^a-z0-9_./\\-])`
	re, err := regexp.Compile(pattern)
	if err != nil {
		return false
	}
	for _, match := range re.FindAllStringSubmatchIndex(message, -1) {
		prefix := message[:match[3]]
		start := 0
		for _, separator := range []string{"，", ",", "。", "；", ";", "\n", "而是", "改查", "改为", "切换到", "换成"} {
			if index := strings.LastIndex(prefix, separator); index >= 0 {
				start = max(start, index+len(separator))
			}
		}
		prefix = prefix[start:]
		negated := false
		for _, phrase := range []string{"不要", "不用", "无需", "别查", "别看", "别检查", "不是", "并非", "排除", "不查", "不看", "不检查", "不查看"} {
			negated = negated || strings.Contains(prefix, phrase)
		}
		if !negated {
			return true
		}
	}
	return false
}

func ResourceAddressMentioned(message, address string) bool {
	return directoryLiteralMention(message, address)
}
func resolveDirectoryFilter(c Config, a map[string]any) (map[string]bool, error) {
	ref, path := str(a["folder_ref"]), str(a["folder_path"])
	if ref == "" && path == "" {
		return nil, nil
	}
	matches := []AssetDirectory{}
	for _, d := range c.Directories {
		if ref != "" && ref != "g_"+hash(d.ID)[:16] {
			continue
		}
		if path != "" && DirectoryNameKey(path) != DirectoryNameKey(strings.Join(d.Path, "/")) && DirectoryNameKey(path) != DirectoryNameKey(d.Name) {
			continue
		}
		matches = append(matches, d)
	}
	if len(matches) != 1 {
		paths := []string{}
		for _, d := range matches {
			paths = append(paths, strings.Join(d.Path, "/"))
		}
		if len(matches) == 0 {
			return nil, errors.New("资源目录不存在；请先调用 list_resource_groups 查看当前项目目录")
		}
		return nil, errors.New("目录名称不唯一；请使用 list_resource_groups 的 folder_ref 选择完整目录路径：" + strings.Join(paths, "、"))
	}
	ids := map[string]bool{}
	for _, id := range matches[0].ResourceIDs {
		ids[id] = true
	}
	return ids, nil
}
func directoryDiscovery(c Config) []map[string]any {
	groups := []map[string]any{}
	for _, d := range c.Directories {
		count := 0
		for _, id := range d.ResourceIDs {
			for _, as := range c.Assets {
				if as.ID == id && assetVisible(c, id) {
					count++
					break
				}
			}
		}
		groups = append(groups, map[string]any{"folder_ref": "g_" + hash(d.ID)[:16], "name": d.Name, "folder_path": strings.Join(d.Path, "/"), "resource_count": len(d.ResourceIDs), "accessible_resource_count": count})
	}
	return groups
}
func assetVisible(c Config, id string) bool {
	if c.Permissions == nil || !c.Permissions.BlockUnreferencedAssets {
		return true
	}
	for _, ref := range c.ReferencedAssets {
		if ref == id {
			return true
		}
	}
	return false
}
func listDirectoryAssets(c Config, a map[string]any) (any, error) {
	allowed, err := resolveDirectoryFilter(c, a)
	if err != nil {
		return nil, err
	}
	pattern := str(a["pattern"])
	re, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, errors.New("invalid asset filter regex")
	}
	list := []any{}
	literal := pattern != "" && !strings.ContainsAny(pattern, `\.^$*+?()[]{}|`)
	for _, as := range c.Assets {
		if !assetVisible(c, as.ID) || allowed != nil && !allowed[as.ID] {
			continue
		}
		info := map[string]any{"asset_ref": assetAlias(as.ID), "name": as.Name, "type": as.Kind, "path": str(as.Settings["path"]), "db_type": str(as.Settings["driver"]), "folder_path": strings.Join(as.FolderPath, "/"), "folder_names": as.FolderPath}
		if host := str(as.Settings["host"]); host != "" {
			info["host"] = host
		}
		if as.SSH != nil {
			info["host"] = as.SSH.Host
		}
		if r := str(as.Settings["ssh_asset_ref"]); r != "" {
			info["ssh_asset_ref"] = assetAlias(r)
		}
		match := re.MatchString(js(info))
		if !match && literal {
			for _, folder := range as.FolderPath {
				match = match || DirectoryNameKey(pattern) == DirectoryNameKey(folder)
			}
		}
		if match {
			info["agent_capabilities"] = resourceAgentCapabilities(as.Kind)
			list = append(list, info)
		}
	}
	return list, nil
}
func scopeAllows(scope *TargetScope, ref string) bool {
	for _, id := range scope.ResourceIDs {
		if ref == id || ref == assetAlias(id) {
			return true
		}
	}
	return false
}
func enforceTargetScope(c Config, name string, a, policy map[string]any) error {
	if c.targetScope == nil || name == "list_assets" || name == "list_resource_groups" || name == "render_chart" || strings.HasPrefix(name, "web_") || name == "read_investigation" || name == "read_evidence" || name == "preview_resource_import" || name == "import_resources" || name == "inspect_attachment" {
		return nil
	}
	if c.targetScope.NeedsClarification || len(c.targetScope.ResourceIDs) == 0 {
		return errors.New("当前目录目标尚未明确或没有资源；请根据项目目录向用户澄清，不得沿用旧主机或本地配置")
	}
	if name == "delegate_investigation" {
		return nil
	} // Each investigator is checked when registering its assigned assets.
	ref := str(a["asset_ref"])
	if ref == "" {
		ref = str(policy["asset_ref"])
	}
	if ref == "" {
		ref = c.AssetRef
	}
	if !scopeAllows(c.targetScope, ref) {
		return errors.New("操作目标不在用户指定的资源目录内；请使用当前目录资源，不得回退到旧主机或本地 kubeconfig")
	}
	// 目录已选定目标集合，调用目标又通过了域内校验，逐条调用不再要求重新选择资源。
	if policy != nil {
		policy["needsTarget"] = false
	}
	return nil
}

// AssetAlias exposes the model-facing reference format to trusted adapters.
func AssetAlias(id string) string { return assetAlias(id) }
