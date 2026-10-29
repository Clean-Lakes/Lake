package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
)

func strategyMust[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func strategyExactKeys(raw json.RawMessage, typ reflect.Type) bool {
	if typ.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return true
		}
		return strategyExactKeys(raw, typ.Elem())
	}
	if typ.Kind() != reflect.Struct {
		return true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	allowed := map[string]reflect.Type{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			allowed[name] = f.Type
		}
	}
	for key, value := range fields {
		ft, ok := allowed[key]
		if !ok || !strategyExactKeys(value, ft) {
			return false
		}
	}
	return true
}

// Reject duplicate keys, nulls and trailing documents before strict typed
// decoding; encoding/json alone accepts duplicate keys and missing booleans.
func strategyJSONValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	if t == nil {
		return errors.New("null")
	}
	if delim, ok := t.(json.Delim); ok {
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return e
				}
				k, ok := key.(string)
				if !ok || seen[k] {
					return errors.New("duplicate")
				}
				seen[k] = true
				if e = strategyJSONValue(d); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := strategyJSONValue(d); e != nil {
					return e
				}
			}
		default:
			return errors.New("invalid JSON")
		}
		_, err = d.Token()
	}
	return err
}

func strategyBody[T any](r *http.Request, required ...string) T {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 128001))
	if err != nil || len(raw) > 128000 {
		strategyFail(400, "invalid_body")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if strategyJSONValue(d) != nil {
		strategyFail(400, "invalid_body")
	}
	if _, e := d.Token(); e != io.EOF {
		strategyFail(400, "invalid_body")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		strategyFail(400, "invalid_body")
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			strategyFail(400, "missing_field")
		}
	}
	var out T
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&out) != nil {
		strategyFail(400, "invalid_body")
	}
	// Also reject case aliases accepted by encoding/json, including nested fields.
	if !strategyExactKeys(raw, reflect.TypeOf(out)) {
		strategyFail(400, "unknown_field")
	}

	return out
}

func (b *Server) strategyRoute(w http.ResponseWriter, r *http.Request, path string) bool {
	ctx := StrategyContext{}
	if path != "/api/strategy" && !strings.HasPrefix(path, "/api/strategy/") {
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) < 4 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "strategy" {
			return false
		}
		ctx.ProjectID = parts[2]
	}
	// The outer server authenticates first. Validate project scope even for 410.
	_, err := strategyCall(b.Store, false, func() bool { b.Store.strategyContext(ctx); return true })
	if err != nil {
		reply(w, 404, Object{"error": "项目不可用", "code": "strategy_scope_unavailable"})
		return true
	}
	reply(w, 410, Object{"error": "旧策略资产体系已退出；历史资料可通过本地命令导出", "code": "strategy_assets_retired"})
	return true
}
