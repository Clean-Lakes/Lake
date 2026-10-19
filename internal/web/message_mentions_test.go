package web

import (
	"testing"
	"unicode/utf16"
)

func TestMessageMentionsBindOnlyVerifiedSelections(t *testing.T) {
	text := "🔎前@主机后@工具"
	refs := []Object{{"asset_ref": "a", "name": "主机", "type": "ssh"}, {"kind": "mcp", "server_id": "m", "name": "工具"}}
	input := []any{Object{"kind": "resource", "id": "a", "label": "@主机", "start": 3, "end": 6}, Object{"kind": "mcp", "id": "m", "label": "@工具", "start": 7, "end": 10}, Object{"kind": "resource", "id": "foreign", "label": "@主机", "start": 3, "end": 6}}
	mentions := validatedMessageMentions(text, input, refs)
	if len(mentions) != 2 || mentions[0]["resourceKind"] != "ssh" {
		t.Fatalf("incorrect mentions: %v", mentions)
	}
	units := utf16.Encode([]rune(text))
	for _, m := range mentions {
		if string(utf16.Decode(units[integer(m["start"]):integer(m["end"])])) != m["label"] {
			t.Fatal("invalid span")
		}
	}
	if len(validatedMessageMentions(text, []any{Object{"kind": "resource", "id": "a", "label": "@假", "start": 3, "end": 6}}, refs)) != 0 {
		t.Fatal("forged display label accepted")
	}
	if len(validatedMessageMentions(text, input, nil)) != 0 {
		t.Fatal("display references expanded scope")
	}
}
func TestMessageMentionsPersistForImmediateAndQueuedMessages(t *testing.T) {
	b, h := fixture(t)
	id, resource := newSession(t, h)
	name := stringOf(b.Store.Resource(resource)["name"])
	text := "前@" + name + "后"
	span := Object{"kind": "resource", "id": resource, "label": "@" + name, "start": 1, "end": 1 + len(utf16.Encode([]rune("@"+name)))}
	message := b.validateHumanMessage(id, Object{"text": text, "resourceIds": []any{resource}, "mentions": []any{span}})
	m, _ := b.Store.BeginWithMentionsAndNaming(id, message.Text, nil, nil, message.Mentions)
	if m["text"] != text || len(objects(m["mentions"])) != 1 {
		t.Fatal("immediate reply lost tags")
	}
	b.Store.Status(id, "completed")
	q := b.Store.EnqueueMessage(id, Object{"text": text, "resourceIds": []any{resource}, "mentions": message.Mentions})
	queued, _ := b.Store.BeginQueuedMessageWithMentions(id, stringOf(q["queuedMessageId"]), text, nil, text, nil, message.Mentions)
	if len(objects(queued["mentions"])) != 1 {
		t.Fatal("queue dispatch lost tags")
	}
	snapshot := b.Store.Snapshot(id)
	for _, m := range objects(snapshot["messages"]) {
		if m["role"] == "user" && len(objects(m["mentions"])) != 1 {
			t.Fatal("history lost tags")
		}
	}
	b.Store.Status(id, "completed")
	b.Store.BeginWithMentionsAndNaming(id, "@"+name, nil, nil, []Object{})
	last := objects(b.Store.Snapshot(id)["messages"])
	if last[len(last)-1]["mentions"] == nil {
		t.Fatal("explicit plain text lost empty metadata")
	}
}

func TestMessageMentionsSurviveReopenAndLegacyMessagesStayDistinct(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CreateProject("mention history")
	session := store.CreateSession(stringOf(project["id"]), "history", nil)
	id := stringOf(session["id"])
	store.AddMessage(id, "user", "legacy @A", nil)
	mentions := []Object{{"kind": "resource", "id": "historic-resource", "label": "@A", "start": 0, "end": 2, "resourceKind": "ssh"}}
	store.BeginWithMentionsAndNaming(id, "@A 后续", nil, nil, mentions)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	messages := []Object{}
	for _, message := range objects(store.Snapshot(id)["messages"]) {
		if message["role"] == "user" {
			messages = append(messages, message)
		}
	}
	if len(messages) != 2 || messages[0]["mentions"] != nil || len(objects(messages[1]["mentions"])) != 1 {
		t.Fatal("persisted mentions or legacy marker changed")
	}
	if messages[1]["text"] != "@A 后续" {
		t.Fatal("stored user text was rewritten")
	}
}
