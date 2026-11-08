package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSpecialistReadWatermarkSurvivesReopenAndLateWrites(t *testing.T) {
	home := t.TempDir()
	var project, other string
	const latest = "00000000000000000003"
	t.Run("write", func(t *testing.T) {
		b, _ := fixtureAtHome(t, home)
		project = stringOf(b.Store.CreateProject("First")["id"])
		other = stringOf(b.Store.CreateProject("Other")["id"])
		b.Store.ensureSuperSession(project, "first-session", "Release", "role")
		b.Store.ensureSuperSession(other, "other-session", "Release", "role")
		b.Store.update(func() any {
			b.Store.exec("INSERT INTO superagentRoleChannels(channelId,projectId,roleId,sessionId) VALUES(?,?,?,?),(?,?,?,?)", "first", project, "release", "first-session", "other", other, "release", "other-session")
			return nil
		})
		for _, cursor := range []string{latest, "00000000000000000001", latest} {
			if seen := b.Store.markSpecialistRead("first", cursor); seen != latest {
				t.Fatalf("read cursor moved backwards: %s", seen)
			}
		}
	})
	b, _ := fixtureAtHome(t, home)
	channels := []ai.SpecialistChannel{{ID: "first", RoleID: "release"}}
	b.populateSpecialistReads(project, channels)
	if channels[0].SeenCompletionCursor != latest {
		t.Fatal("reopening the workspace lost the read cursor")
	}
	channels = []ai.SpecialistChannel{{ID: "other", RoleID: "release"}}
	b.populateSpecialistReads(other, channels)
	if channels[0].SeenCompletionCursor != "" {
		t.Fatal("read cursor leaked across projects")
	}
}
