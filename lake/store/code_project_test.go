package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCodeProjectBindsOnlyToConversationInSameLake(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "测试湖", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLake(ctx, "生产湖", ""); err != nil {
		t.Fatal(err)
	}
	testConversation, err := s.CreateConversation(ctx, "测试湖")
	if err != nil {
		t.Fatal(err)
	}
	prodConversation, err := s.CreateConversation(ctx, "生产湖")
	if err != nil {
		t.Fatal(err)
	}
	projectPath := filepath.Join(t.TempDir(), "source")
	if err := os.Mkdir(projectPath, 0700); err != nil {
		t.Fatal(err)
	}
	project, err := s.CreateCodeProject(ctx, "测试湖", "source", projectPath)
	if err != nil {
		t.Fatal(err)
	}
	projectPath, err = filepath.EvalSymlinks(projectPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetConversationProject(ctx, prodConversation.ID, project.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-lake bind error = %v", err)
	}
	bound, err := s.SetConversationProject(ctx, testConversation.ID, project.ID)
	if err != nil || bound.ProjectPath != projectPath {
		t.Fatalf("bound=%+v err=%v", bound, err)
	}
	listed, err := s.ListCodeProjects(ctx)
	if err != nil || len(listed) != 1 || listed[0].ID != project.ID {
		t.Fatalf("projects=%+v err=%v", listed, err)
	}
	cleared, err := s.SetConversationProject(ctx, testConversation.ID, "")
	if err != nil || cleared.ProjectID != "" {
		t.Fatalf("cleared=%+v err=%v", cleared, err)
	}
}
