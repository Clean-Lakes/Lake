package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const UICatalogID = "com.cleanlakes.lake:catalog-v1"
const UIVersion = "v0.9.1"

var uiIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

type UIMessage struct {
	Version          string              `json:"version"`
	CreateSurface    *UICreateSurface    `json:"createSurface,omitempty"`
	UpdateComponents *UIUpdateComponents `json:"updateComponents,omitempty"`
	UpdateDataModel  *UIUpdateDataModel  `json:"updateDataModel,omitempty"`
	DeleteSurface    *UIDeleteSurface    `json:"deleteSurface,omitempty"`
}
type UICreateSurface struct {
	SurfaceID string `json:"surfaceId"`
	CatalogID string `json:"catalogId"`
}
type UIUpdateComponents struct {
	SurfaceID  string           `json:"surfaceId"`
	Components []map[string]any `json:"components"`
}
type UIUpdateDataModel struct {
	SurfaceID string `json:"surfaceId"`
	Path      string `json:"path,omitempty"`
	Value     any    `json:"value,omitempty"`
}
type UIDeleteSurface struct {
	SurfaceID string `json:"surfaceId"`
}
type UISnapshot struct {
	SurfaceID  string           `json:"surfaceId"`
	CatalogID  string           `json:"catalogId"`
	Revision   uint64           `json:"revision"`
	Kind       string           `json:"kind,omitempty"`
	Components []map[string]any `json:"components"`
	Data       map[string]any   `json:"data"`
	Deleted    bool             `json:"deleted,omitempty"`
}
type UIUserAction struct {
	SurfaceID         string         `json:"surfaceId"`
	SourceComponentID string         `json:"sourceComponentId"`
	Name              string         `json:"name"`
	Context           map[string]any `json:"context"`
	Revision          uint64         `json:"revision"`
}
type UISession struct {
	mu        sync.Mutex
	surfaces  map[string]UISnapshot
	revisions map[string]uint64
}

func NewUISession() *UISession {
	return &UISession{surfaces: map[string]UISnapshot{}, revisions: map[string]uint64{}}
}
func cloneUI[T any](v T) T {
	b, _ := json.Marshal(v)
	var result T
	_ = json.Unmarshal(b, &result)
	return result
}
func (s *UISession) Get(id string) (UISnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.surfaces[id]
	return cloneUI(v), ok
}
func (s *UISession) Restore(v UISnapshot) error {
	if err := v.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.Revision < s.revisions[v.SurfaceID] {
		return errors.New("不能恢复旧版本界面")
	}
	s.revisions[v.SurfaceID] = v.Revision
	if v.Deleted {
		delete(s.surfaces, v.SurfaceID)
	} else {
		s.surfaces[v.SurfaceID] = cloneUI(v)
	}
	return nil
}

// Prepare is transactional. Persistence must succeed before Restore commits
// the resulting snapshots; invalid batches never damage the last valid UI.
func (s *UISession) Prepare(messages []UIMessage, kind string) ([]UISnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(messages) < 1 || len(messages) > 12 {
		return nil, errors.New("每次提供1至12条A2UI消息")
	}
	next := cloneUI(s.surfaces)
	changed := map[string]bool{}
	for _, m := range messages {
		if m.Version != UIVersion && m.Version != "v0.9" {
			return nil, errors.New("A2UI版本必须为v0.9.1")
		}
		count := 0
		id := ""
		if m.CreateSurface != nil {
			count++
			id = m.CreateSurface.SurfaceID
		}
		if m.UpdateComponents != nil {
			count++
			id = m.UpdateComponents.SurfaceID
		}
		if m.UpdateDataModel != nil {
			count++
			id = m.UpdateDataModel.SurfaceID
		}
		if m.DeleteSurface != nil {
			count++
			id = m.DeleteSurface.SurfaceID
		}
		if count != 1 || !uiIdentifier.MatchString(id) {
			return nil, errors.New("消息必须有一个操作和有效surfaceId")
		}
		v, exists := next[id]
		if m.CreateSurface != nil {
			if exists && !v.Deleted {
				return nil, errors.New("面板已存在，请使用updateComponents或updateDataModel更新")
			}
			if m.CreateSurface.CatalogID != UICatalogID {
				return nil, errors.New("未知组件目录")
			}
			if len(next) >= 16 && !exists {
				return nil, errors.New("本会话最多16个动态面板")
			}
			v = UISnapshot{SurfaceID: id, CatalogID: UICatalogID, Kind: kind, Components: []map[string]any{}, Data: map[string]any{}}
		} else if !exists || v.Deleted {
			return nil, errors.New("先用createSurface创建面板")
		}
		if m.UpdateComponents != nil {
			if len(m.UpdateComponents.Components) < 1 || len(m.UpdateComponents.Components) > 64 {
				return nil, errors.New("组件数必须为1至64")
			}
			indices := map[string]int{}
			for i, c := range v.Components {
				cid, _ := c["id"].(string)
				indices[cid] = i
			}
			seen := map[string]bool{}
			for _, c := range m.UpdateComponents.Components {
				cid, _ := c["id"].(string)
				if seen[cid] {
					return nil, errors.New("组件ID重复")
				}
				seen[cid] = true
				if i, ok := indices[cid]; ok {
					v.Components[i] = cloneUI(c)
				} else {
					v.Components = append(v.Components, cloneUI(c))
					indices[cid] = len(v.Components) - 1
				}
			}
		}
		if m.UpdateDataModel != nil {
			u := m.UpdateDataModel
			if u.Path == "" || u.Path == "/" {
				data, ok := u.Value.(map[string]any)
				if !ok {
					return nil, errors.New("面板根数据必须是对象")
				}
				v.Data = cloneUI(data)
			} else {
				parts, err := uiPointer(u.Path)
				if err != nil {
					return nil, err
				}
				var current any = v.Data
				updated, err := setUIPath(current, parts, u.Value)
				if err != nil {
					return nil, err
				}
				v.Data = updated.(map[string]any)
			}
		}
		if m.DeleteSurface != nil {
			v.Deleted = true
		}
		next[id] = v
		changed[id] = true
	}
	ids := []string{}
	for id := range changed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := []UISnapshot{}
	for _, id := range ids {
		v := next[id]
		v.Revision = s.revisions[id] + 1
		if err := v.Validate(); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, nil
}

func uiPointer(path string) ([]string, error) {
	if !strings.HasPrefix(path, "/") || len(path) > 256 {
		return nil, errors.New("数据绑定须使用有界绝对JSON Pointer")
	}
	parts := strings.Split(path[1:], "/")
	if len(parts) > 8 {
		return nil, errors.New("数据路径过深")
	}
	for i, p := range parts {
		p = strings.ReplaceAll(strings.ReplaceAll(p, "~1", "/"), "~0", "~")
		if p == "" || p == "__proto__" || p == "constructor" || p == "prototype" {
			return nil, errors.New("数据路径不允许此键")
		}
		parts[i] = p
	}
	return parts, nil
}
func setUIPath(current any, parts []string, value any) (any, error) {
	if len(parts) == 0 {
		return cloneUI(value), nil
	}
	m, ok := current.(map[string]any)
	if !ok {
		return nil, errors.New("增量路径必须指向对象")
	}
	child := m[parts[0]]
	if len(parts) > 1 && child == nil {
		child = map[string]any{}
	}
	if len(parts) == 1 && value == nil {
		delete(m, parts[0])
		return m, nil
	}
	v, err := setUIPath(child, parts[1:], value)
	if err != nil {
		return nil, err
	}
	m[parts[0]] = v
	return m, nil
}

var uiFields = map[string][]string{
	"Column": {"children"}, "Row": {"children"}, "Card": {"children", "title"}, "Tabs": {"children", "labels", "active"},
	"Text": {"text", "variant"}, "Markdown": {"text"}, "Code": {"text", "label", "language"}, "List": {"label", "items", "ordered", "start"},
	"Metric": {"label", "value"}, "Chart": {"label", "values", "unit", "max"}, "Button": {"label", "action"},
	"ChoicePicker": {"label", "value", "options"}, "TextField": {"label", "value"},
	"Table": {"columns", "headers", "rows", "action", "label"}, "Log": {"text", "label"},
}

func (v UISnapshot) Validate() error {
	if !uiIdentifier.MatchString(v.SurfaceID) || v.CatalogID != UICatalogID || (v.Kind != "" && v.Kind != "ports") {
		return errors.New("面板标识无效")
	}
	b, err := json.Marshal(v)
	if err != nil || len(b) > 48*1024 {
		return errors.New("面板数据超过48KiB")
	}
	if v.Deleted {
		return nil
	}
	if v.Data == nil || len(v.Components) > 64 {
		return errors.New("面板数据或组件数量无效")
	}
	if err := checkUIValue(v.Data, 0); err != nil {
		return err
	}
	nodes := map[string]map[string]any{}
	edges := map[string][]string{}
	for _, c := range v.Components {
		id, _ := c["id"].(string)
		name, _ := c["component"].(string)
		fields, ok := uiFields[name]
		if !ok || !uiIdentifier.MatchString(id) || nodes[id] != nil {
			return errors.New("未知组件或重复ID")
		}
		nodes[id] = c
		allowed := map[string]bool{"id": true, "component": true}
		for _, f := range fields {
			allowed[f] = true
		}
		for key := range c {
			if !allowed[key] {
				return fmt.Errorf("组件%s不支持字段%s", name, key)
			}
		}
		for key, value := range c {
			if key == "id" || key == "component" {
				continue
			}
			if err := checkUIValue(value, 0); err != nil {
				return err
			}
			switch key {
			case "ordered":
				if _, ok := value.(bool); !ok {
					return errors.New("清单ordered必须为布尔值")
				}
			case "max", "start":
				n, ok := value.(float64)
				if !ok || n <= 0 || n > 1e12 || (key == "start" && (n > 1000000 || n != float64(int(n)))) {
					return errors.New("图表范围或清单起始编号无效")
				}
			case "language":
				if language, ok := value.(string); !ok || len(language) > 80 {
					return errors.New("代码语言应为有界文字")
				}
			case "active":
				if number, ok := value.(float64); ok {
					if number < 0 || number > 63 || number != float64(int(number)) {
						return errors.New("标签索引无效")
					}
				} else {
					binding, ok := value.(map[string]any)
					if !ok || len(binding) != 1 {
						return errors.New("标签绑定无效")
					}
					path, _ := binding["path"].(string)
					if _, err := uiPointer(path); err != nil {
						return err
					}
				}
			case "children", "labels", "columns", "headers":
				a, ok := value.([]any)
				if !ok || len(a) > 64 {
					return errors.New("列表字段无效")
				}
				for _, item := range a {
					str, ok := item.(string)
					if !ok {
						return errors.New("列表应包含字符串")
					}
					if key == "children" {
						edges[id] = append(edges[id], str)
					}
				}
			case "action":
				if err := validateUIAction(value, v.Kind); err != nil {
					return err
				}
			case "text", "value", "label", "title", "unit":
				if _, ok := value.(string); !ok {
					m, ok := value.(map[string]any)
					if !ok || len(m) != 1 {
						return errors.New("文本应为字符串或path绑定")
					}
					path, ok := m["path"].(string)
					if !ok {
						return errors.New("文本绑定无效")
					}
					if _, err := uiPointer(path); err != nil {
						return err
					}
				}
			case "rows", "options", "values", "items":
				if _, ok := value.([]any); !ok {
					m, ok := value.(map[string]any)
					if !ok || len(m) != 1 {
						return errors.New("列表应为数组或path绑定")
					}
					path, _ := m["path"].(string)
					if _, err := uiPointer(path); err != nil {
						return err
					}
				}
			}
		}
		required := map[string][]string{"Column": {"children"}, "Row": {"children"}, "Card": {"children", "title"}, "Tabs": {"children", "labels"}, "Text": {"text"}, "Markdown": {"text"}, "Code": {"text"}, "List": {"items"}, "Metric": {"label", "value"}, "Chart": {"label", "values"}, "Button": {"label", "action"}, "ChoicePicker": {"label", "value", "options"}, "TextField": {"label", "value"}, "Table": {"columns", "rows"}, "Log": {"text"}}
		for _, key := range required[name] {
			if c[key] == nil {
				return fmt.Errorf("%s缺少%s", name, key)
			}
		}
		if name == "Tabs" && len(edges[id]) != len(c["labels"].([]any)) {
			return errors.New("标签与子组件数不匹配")
		}
		if name == "Tabs" && (len(edges[id]) < 1 || len(edges[id]) > 6) {
			return errors.New("标签页必须为1至6个")
		}
		if name == "Table" && (len(c["columns"].([]any)) < 1 || len(c["columns"].([]any)) > 12) {
			return errors.New("表格列数必须为1至12")
		}
		if name == "Table" && c["headers"] != nil && len(c["headers"].([]any)) != len(c["columns"].([]any)) {
			return errors.New("表格headers与columns数量不匹配")
		}
		if err := validateUIBoundData(c, v.Data); err != nil {
			return err
		}
	}
	if len(nodes) == 0 {
		return nil
	}
	if nodes["root"] == nil {
		return errors.New("面板须有id为root的根组件")
	}
	visiting := map[string]bool{}
	seen := map[string]bool{}
	var visit func(string, int) error
	visit = func(id string, depth int) error {
		if depth > 8 || visiting[id] {
			return errors.New("组件循环或超过8层")
		}
		if nodes[id] == nil {
			return errors.New("引用了不存在的组件")
		}
		if seen[id] {
			return errors.New("组件不能重复引用")
		}
		visiting[id] = true
		seen[id] = true
		for _, child := range edges[id] {
			if err := visit(child, depth+1); err != nil {
				return err
			}
		}
		delete(visiting, id)
		return nil
	}
	if err := visit("root", 1); err != nil {
		return err
	}
	for id := range nodes {
		if !seen[id] {
			// Old disconnected components may remain after an incremental layout
			// update. Check their graph independently of the active root tree.
			seen = map[string]bool{}
			if err := visit(id, 1); err != nil {
				return err
			}
		}
	}
	return nil
}
func checkUIValue(v any, depth int) error {
	if depth > 8 {
		return errors.New("数据超过8层")
	}
	switch x := v.(type) {
	case string:
		if len(x) > 16384 {
			return errors.New("文本过长")
		}
	case map[string]any:
		if len(x) > 64 {
			return errors.New("对象字段过多")
		}
		for k, c := range x {
			if k == "__proto__" || k == "constructor" || k == "prototype" || len(k) > 96 {
				return errors.New("不允许的数据键")
			}
			if err := checkUIValue(c, depth+1); err != nil {
				return err
			}
		}
	case []any:
		if len(x) > 200 {
			return errors.New("列表超过200行")
		}
		for _, c := range x {
			if err := checkUIValue(c, depth+1); err != nil {
				return err
			}
		}
	case nil, bool, float64:
	default:
		return errors.New("只接受JSON数据")
	}
	return nil
}
func resolveUIValue(value any, data map[string]any) (any, bool) {
	if binding, ok := value.(map[string]any); ok {
		path, ok := binding["path"].(string)
		if !ok {
			return nil, false
		}
		parts, err := uiPointer(path)
		if err != nil {
			return nil, false
		}
		var current any = data
		for _, part := range parts {
			m, ok := current.(map[string]any)
			if !ok {
				return nil, false
			}
			current, ok = m[part]
			if !ok {
				return nil, false
			}
		}
		return current, true
	}
	return value, true
}
func validateUIBoundData(c, data map[string]any) error {
	if raw, exists := c["active"]; exists {
		if value, found := resolveUIValue(raw, data); found {
			number, ok := value.(float64)
			labels, _ := c["labels"].([]any)
			if !ok || number < 0 || number >= float64(len(labels)) || number != float64(int(number)) {
				return errors.New("标签索引超出标签页范围")
			}
		}
	}
	for _, key := range []string{"text", "label", "title", "value", "unit"} {
		if raw, exists := c[key]; exists {
			if value, found := resolveUIValue(raw, data); found {
				if _, ok := value.(string); !ok {
					return fmt.Errorf("%s绑定的数据必须为字符串", key)
				}
			}
		}
	}
	for _, key := range []string{"rows", "options", "values", "items"} {
		raw, exists := c[key]
		if !exists {
			continue
		}
		resolved, found := resolveUIValue(raw, data)
		if !found {
			continue
		}
		rows, ok := resolved.([]any)
		if !ok {
			return errors.New("列表绑定的数据必须为数组")
		}
		if key == "values" && len(rows) > 16 {
			return errors.New("图表最多16个数值")
		}
		for _, rawRow := range rows {
			if key == "items" {
				if _, ok := rawRow.(string); !ok {
					return errors.New("清单项必须为文字")
				}
				continue
			}
			row, ok := rawRow.(map[string]any)
			if !ok {
				return errors.New("列表中的记录必须为对象")
			}
			if key == "rows" {
				for _, value := range row {
					switch value.(type) {
					case string, float64, bool, nil:
					default:
						return errors.New("表格单元格应为简单值")
					}
				}
			} else if key == "options" {
				if _, ok := row["label"].(string); !ok {
					return errors.New("选项缺少文字label")
				}
				if _, ok := row["value"].(string); !ok {
					return errors.New("选项缺少文字value")
				}
			} else {
				label, ok := row["label"].(string)
				if !ok || label == "" {
					return errors.New("图表项缺少label")
				}
				n, ok := row["value"].(float64)
				if !ok || n < 0 {
					return errors.New("图表值必须为非负数")
				}
				if max, ok := c["max"].(float64); ok && n > max {
					return errors.New("图表数值超过指定范围")
				}
			}
		}
	}
	return nil
}

func validateUIAction(value any, kind string) error {
	m, ok := value.(map[string]any)
	if !ok || len(m) != 1 {
		return errors.New("动作须使用event")
	}
	e, ok := m["event"].(map[string]any)
	if !ok || len(e) > 2 {
		return errors.New("动作event无效")
	}
	name, _ := e["name"].(string)
	if name != "continue" && !(kind == "ports" && (name == "inspect_ports" || name == "inspect_process")) {
		return errors.New("未知操作")
	}
	for key := range e {
		if key != "name" && key != "context" {
			return errors.New("动作字段无效")
		}
	}
	if raw, exists := e["context"]; exists {
		context, ok := raw.(map[string]any)
		if !ok || len(context) > 8 {
			return errors.New("动作上下文应为最多8个字段的对象")
		}
		for _, value := range context {
			switch x := value.(type) {
			case string, bool, float64:
			case map[string]any:
				path, ok := x["path"].(string)
				if !ok || len(x) != 1 {
					return errors.New("动作仅允许简单值或path绑定")
				}
				if _, err := uiPointer(path); err != nil {
					return err
				}
			default:
				return errors.New("动作上下文不允许嵌套代码或对象")
			}
		}
	}
	return nil
}
func (s *UISession) CheckAction(a UIUserAction) (UISnapshot, error) {
	v, ok := s.Get(a.SurfaceID)
	if !ok || v.Deleted || a.Revision != v.Revision {
		return v, errors.New("界面已更新，请使用当前面板重新操作")
	}
	var found map[string]any
	for _, c := range v.Components {
		if c["id"] == a.SourceComponentID {
			found = c
			break
		}
	}
	// Incremental layouts may retain old components. Only components reachable
	// from the current root can originate an interaction.
	nodes := map[string]map[string]any{}
	for _, c := range v.Components {
		nodes[c["id"].(string)] = c
	}
	var reachable func(string) bool
	reachable = func(id string) bool {
		if id == a.SourceComponentID {
			return true
		}
		children, _ := nodes[id]["children"].([]any)
		for _, child := range children {
			if reachable(child.(string)) {
				return true
			}
		}
		return false
	}
	if !reachable("root") {
		return v, errors.New("此组件已不在当前界面中")
	}
	action, _ := found["action"].(map[string]any)
	event, _ := action["event"].(map[string]any)
	if event["name"] != a.Name {
		return v, errors.New("此组件未声明该操作")
	}
	b, _ := json.Marshal(a.Context)
	if len(b) > 4096 || checkUIValue(a.Context, 0) != nil {
		return v, errors.New("操作参数无效")
	}
	if a.Name == "continue" {
		expected, _ := event["context"].(map[string]any)
		if len(expected) != len(a.Context) {
			return v, errors.New("操作参数不匹配")
		}
		for key, ex := range expected {
			actual, present := a.Context[key]
			if !present {
				return v, errors.New("缺少操作参数")
			}
			if binding, ok := ex.(map[string]any); ok {
				if _, ok := binding["path"].(string); !ok {
					return v, errors.New("操作绑定无效")
				}
				switch actual.(type) {
				case string, bool, float64:
				default:
					return v, errors.New("表单参数必须是简单值")
				}
			} else {
				left, _ := json.Marshal(ex)
				right, _ := json.Marshal(a.Context[key])
				if string(left) != string(right) {
					return v, errors.New("操作内容不匹配")
				}
			}
		}
	}
	return v, nil
}
