package web

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"strings"
)

func references(store *Store, id string, value any, resolvers ...func(string, string) string) []Object {
	if value == nil {
		return []Object{}
	}
	a, ok := value.([]any)
	if !ok || len(a) > 40 {
		fail(400, "最多 40 项上下文引用")
	}
	out := []Object{}
	for _, v := range a {
		r, ok := v.(map[string]any)
		if !ok {
			fail(400, "Invalid reference")
		}
		kind := stringOf(r["kind"])
		field := func(key string) string {
			s := stringOf(r[key])
			if len(s) > 1000 {
				return ""
			}
			return s
		}
		ref := field("asset_ref")
		if ref == "" {
			ref = field("assetRef")
		}
		var resource Object
		if ref != "" {
			store.AssertResource(id, ref)
			resource = store.Resource(ref)
		}
		switch kind {
		case "file-local", "file-ssh", "file-container":
			path := field("path")
			rk := stringOf(resource["kind"])
			runtime := rk
			if rk == "docker" {
				runtime = "container"
			}
			if resource == nil || !filepath.IsAbs(path) || strings.ContainsAny(path, "\r\n\x00") || kind != "file-"+runtime {
				fail(400, "File reference target/path invalid")
			}
			container := field("container_id")
			if container == "" {
				container = field("containerId")
			}
			if kind == "file-container" && container == "" {
				fail(400, "Container reference needs container name")
			}
			hash := sha256.Sum256([]byte(jsonText([]string{ref, container, path})))
			out = append(out, Object{"kind": kind, "label": path, "path": path, "runtime": runtime, "asset_ref": ref, "container_id": container, "file_ref": fmt.Sprintf("f_%x", hash[:8])})
		case "db-object":
			if resource["kind"] != "database" {
				fail(400, "Database reference requires a database asset")
			}
			schema, table := field("schema"), field("table")
			if schema == "" || table == "" {
				fail(400, "Schema/table required")
			}
			out = append(out, Object{"kind": kind, "asset_ref": ref, "db": field("db"), "schema": schema, "table": table, "object_type": "table", "label": stringOf(resource["name"]) + " · " + schema + "." + table})
		case "terminal-tab", "terminal-command-block":
			tid := field("terminal_id")
			if tid == "" {
				tid = field("terminalId")
			}
			owner := id
			if len(resolvers) > 0 {
				owner = resolvers[0](id, tid)
			}
			term := store.Terminal(owner, tid)
			host := store.Resource(stringOf(term["resourceId"]))
			if kind == "terminal-tab" {
				out = append(out, Object{"kind": kind, "terminal_id": tid, "asset_ref": host["id"], "label": stringOf(host["name"]) + " 终端", "status": term["status"]})
			} else {
				block := field("block_id")
				if block == "" {
					block = field("blockId")
				}
				entry := store.Entry(owner, tid, block)
				out = append(out, Object{"kind": kind, "terminal_id": tid, "block_id": block, "asset_ref": host["id"], "label": entry["command"], "command": entry["command"], "output": tail(stringOf(entry["output"]), 10000), "exitCode": entry["exitCode"]})
			}
		default:
			fail(400, "Unsupported reference kind")
		}
	}
	return out
}
