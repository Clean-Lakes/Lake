package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func memoryReferenceHistory(tool string, result Object) []ai.Message {
	return []ai.Message{{Role: "user", Content: "请记住发布方案格式。"}, {Role: "assistant", Calls: []ai.Call{{ID: "prior-memory", Name: tool}}}, {Role: "tool", CallID: "prior-memory", Name: tool, Content: jsonText(result)}, {Role: "assistant", Content: "已处理。"}, {Role: "user", Content: "请忘记刚才保存的发布方案格式约定。"}}
}

func TestMemoryForgetResolvesOnlyUnambiguousProvenReferences(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := stringOf(s.CreateProject("Reference fixture")["id"])
	m := MemoryMutation{Key: "release-plan-standard-four-sections", Type: "project", Description: "本项目所有发布/变更方案固定按“影响范围、执行步骤、验证方法、回退方案”四段顺序组织", Body: "发布方案包含影响范围、执行步骤、验证方法和回退方案。", Verification: "user-stated", SourceKind: "user"}
	receipt := s.CommitProjectMemory(p, m)
	saved := memoryReferenceHistory("save_project_memory", receipt)
	read := memoryReferenceHistory("read_project_memory", s.ReadProjectMemory(p, m.Key, false))
	cases := []struct {
		name, text, key string
		history         []ai.Message
		want            bool
	}{
		{"screenshot", "请忘记刚才保存的发布方案格式约定。", m.Key, saved, true},
		{"bare reference", "请忘记刚才保存的那条约定。", m.Key, saved, true},
		{"read reference", "请忘记刚才读取的发布方案格式约定。", m.Key, read, true},
		{"read is not save", "请忘记刚才保存的发布方案格式约定。", m.Key, read, false},
		{"explicit key", "请忘记 " + m.Key + " 这条记忆。", m.Key, nil, true},
		{"explicit title", "请忘记“" + m.Description + "”这条记忆。", m.Key, nil, true},
		{"unknown topic", "请忘记刚才保存的数据库密码约定。", m.Key, saved, false},
		{"no previous turn", "请忘记刚才保存的那条约定。", m.Key, nil, false},
		{"model chooses another key", "请忘记刚才保存的那条约定。", "another-memory", saved, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := s.identifiesMemoryToForget(p, tc.text, tc.key, tc.history); got != tc.want {
				t.Fatalf("identified=%v, want %v", got, tc.want)
			}
		})
	}

	bad := Object{"key": m.Key, "revision": 1, "commitId": "invented"}
	if s.identifiesMemoryToForget(p, "请忘记刚才保存的那条约定。", m.Key, memoryReferenceHistory("save_project_memory", bad)) {
		t.Fatal("invented save receipt accepted")
	}
	bad = Object{"key": m.Key, "revision": 1, "commitId": receipt["commitId"], "error": "save_failed"}
	if s.identifiesMemoryToForget(p, "请忘记刚才保存的那条约定。", m.Key, memoryReferenceHistory("save_project_memory", bad)) {
		t.Fatal("failed save accepted")
	}
	orphan := append([]ai.Message{}, saved...)
	orphan[1].Calls = nil
	if s.identifiesMemoryToForget(p, "请忘记刚才保存的那条约定。", m.Key, orphan) {
		t.Fatal("unpaired tool result accepted")
	}
	current := []ai.Message{{Role: "user", Content: "Earlier unrelated turn"}, {Role: "assistant", Content: "发布方案已保存，key=" + m.Key}, {Role: "user", Content: "请忘记刚才保存的约定。"}}
	current = append(current, read[1:3]...)
	if s.identifiesMemoryToForget(p, "请忘记刚才那条约定。", m.Key, current) {
		t.Fatal("current-turn read or assistant claim created consent")
	}
	old := append([]ai.Message{}, saved[:4]...)
	old = append(old, ai.Message{Role: "user", Content: "A later unrelated question"}, ai.Message{Role: "assistant", Content: "An answer"}, saved[4])
	if s.identifiesMemoryToForget(p, "请忘记刚才那条约定。", m.Key, old) {
		t.Fatal("reference jumped over a newer user turn")
	}
	retry := append([]ai.Message{}, saved[:4]...)
	retry = append(retry, ai.Message{Role: "user", Content: "请忘记刚才保存的发布方案格式约定。"}, ai.Message{Role: "assistant", Calls: []ai.Call{{ID: "failed-delete", Name: "forget_project_memory"}}}, ai.Message{Role: "tool", CallID: "failed-delete", Name: "forget_project_memory", Content: `{"error":"memory_to_forget_not_identified"}`}, saved[4])
	if !s.identifiesMemoryToForget(p, "请忘记刚才保存的发布方案格式约定。", m.Key, retry, 1) {
		t.Fatal("retry after a rejected deletion lost the saved reference")
	}
	retry[len(retry)-2].Content = `{"deleted":true}`
	if s.identifiesMemoryToForget(p, "请忘记刚才保存的发布方案格式约定。", m.Key, retry, 1) {
		t.Fatal("reference jumped over a completed deletion")
	}

	other := stringOf(s.CreateProject("Other project")["id"])
	s.CommitProjectMemory(other, m)
	if s.identifiesMemoryToForget(other, "请忘记刚才保存的那条约定。", m.Key, saved) || s.identifiesMemoryToForget(other, "请忘记刚才那条约定。", m.Key, read) {
		t.Fatal("reference crossed projects with the same key/revision")
	}
	m.ExpectedRevision = 1
	m.Body = "Changed after the reference."
	s.CommitProjectMemory(p, m)
	if s.identifiesMemoryToForget(p, "请忘记刚才保存的那条约定。", m.Key, saved) {
		t.Fatal("stale reference authorized a changed revision")
	}
}

func TestMemoryForgetRequiresDisambiguationOfPreviousTurnAndTitles(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := stringOf(s.CreateProject("Ambiguous reference")["id"])
	h := []ai.Message{{Role: "user", Content: "请记住这两个方案。"}}
	for _, key := range []string{"first-release-method", "second-release-method"} {
		r := s.CommitProjectMemory(p, MemoryMutation{Key: key, Type: "project", Description: "发布方案格式", Body: "发布方案包含验证步骤。", Verification: "user-stated", SourceKind: "user"})
		h = append(h, ai.Message{Role: "assistant", Calls: []ai.Call{{ID: key, Name: "save_project_memory"}}}, ai.Message{Role: "tool", CallID: key, Name: "save_project_memory", Content: jsonText(r)})
	}
	h = append(h, ai.Message{Role: "user", Content: "请忘记刚才那条约定。"})
	for _, text := range []string{"请忘记刚才那条约定。", "请忘记发布方案格式这条记忆。"} {
		if s.identifiesMemoryToForget(p, text, "first-release-method", h) {
			t.Fatal("ambiguous target silently selected")
		}
	}
	if !s.identifiesMemoryToForget(p, "请忘记 first-release-method 这条记忆。", "first-release-method", h) {
		t.Fatal("explicit selection rejected")
	}
	if memoryMentionsKey("请忘记 release-rule-extra 这条记忆。", "release-rule") {
		t.Fatal("key prefix matched another entry")
	}
}

func TestMemoryForgetRetryOnlyUsesConsecutiveRealUserRequests(t *testing.T) {
	for _, tc := range []struct {
		name     string
		messages []Object
		want     int
	}{
		{"consecutive", []Object{{"role": "user", "text": "请记住发布规则。"}, {"role": "user", "text": "请忘记刚才保存的约定。"}, {"role": "assistant", "text": "删除失败。"}, {"role": "user", "text": "请忘记刚才保存的约定。"}}, 1},
		{"unrelated intervenes", []Object{{"role": "user", "text": "请忘记发布规则。"}, {"role": "user", "text": "今天星期几？"}, {"role": "user", "text": "请忘记刚才保存的约定。"}}, 0},
		{"quoted request", []Object{{"role": "user", "text": "> 请忘记发布规则。"}, {"role": "user", "text": "请忘记刚才保存的约定。"}}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := memoryForgetRetryTurns(tc.messages); got != tc.want {
				t.Fatalf("retry turns=%d, want %d", got, tc.want)
			}
		})
	}
}
