package web

import (
	"sort"
	"unicode/utf16"
)

// Display metadata is separate from model context. Bind only to references
// already resolved for this message; never expand the authorized resource scope.
func validatedMessageMentions(text string, value any, refs []Object) []Object {
	sources := map[string]Object{}
	for _, ref := range refs {
		kind, id := stringOf(ref["kind"]), ""
		switch kind {
		case "skill":
			id = stringOf(ref["skill_name"])
		case "mcp":
			id = stringOf(ref["server_id"])
		case "role":
			id = stringOf(ref["role_id"])
		case "":
			kind, id = "resource", stringOf(ref["asset_ref"])
		default:
			continue
		}
		if id != "" {
			sources[kind+":"+id] = ref
		}
	}
	units := utf16.Encode([]rune(text))
	out := []Object{}
	for _, item := range objects(value) {
		if len(out) >= 40 {
			break
		}
		kind, id := stringOf(item["kind"]), stringOf(item["id"])
		source := sources[kind+":"+id]
		if source == nil {
			continue
		}
		start, end := integer(item["start"]), integer(item["end"])
		label := "@" + stringOf(source["name"])
		if item["start"] == nil || item["end"] == nil || number(item["start"]) != float64(start) || number(item["end"]) != float64(end) || start < 0 || end <= start || end > len(units) || stringOf(item["label"]) != label || string(utf16.Decode(units[start:end])) != label {
			continue
		}
		mention := Object{"kind": kind, "id": id, "label": label, "start": start, "end": end}
		if kind == "resource" {
			mention["resourceKind"] = source["type"]
		}
		out = append(out, mention)
	}
	sort.SliceStable(out, func(i, j int) bool { return integer(out[i]["start"]) < integer(out[j]["start"]) })
	result := []Object{}
	end := 0
	for _, mention := range out {
		if integer(mention["start"]) < end {
			continue
		}
		result = append(result, mention)
		end = integer(mention["end"])
	}
	return result
}

func (s *Store) attachMessageMentions(id string, message Object, mentions []Object) {
	if mentions == nil {
		return
	}
	s.exec("UPDATE messages SET mentions=? WHERE id=? AND sessionId=?", jsonText(mentions), message["id"], id)
	message["mentions"] = mentions
}
