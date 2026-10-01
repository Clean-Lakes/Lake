package tools

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/cloudwego/eino/lake/media"
)

func TestVideoExtractionRejectsPathsBeforeDecoder(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "video.mov"), []byte("not-video"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(other, "video.mov"), filepath.Join(root, "link.mov")); err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{"../video.mov", "link.mov", "/etc/passwd"} {
		if _, err := VideoImagesInProject(context.Background(), root, relative); err == nil {
			t.Fatalf("accepted %q", relative)
		}
	}
	if _, err := media.ExtractVideoFrames(context.Background(), filepath.Join(root, "missing.mov"), 5, 768); err == nil {
		t.Fatal("accepted too many frames")
	}
}
