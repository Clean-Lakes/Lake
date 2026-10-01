//go:build darwin

package media

import (
	"bytes"
	"context"
	"fmt"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func requireSwift(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("swift"); err != nil {
		t.Skip("Swift unavailable")
	}
}

func TestAVFoundationFramesAreBounded(t *testing.T) {
	requireSwift(t)
	const sample = "/System/Library/CoreServices/BluetoothUIService.app/Contents/Resources/Banner-PID-8209-Case-mov/Banner-PID-8209-default-Case-Loop.mov"
	if _, err := os.Stat(sample); err != nil {
		t.Skip("macOS video sample unavailable")
	}
	frames, err := ExtractVideoFrames(context.Background(), sample, 2, 256)
	if err != nil || len(frames) != 2 {
		t.Fatalf("frames=%d err=%v", len(frames), err)
	}
	for _, frame := range frames {
		config, err := jpeg.DecodeConfig(bytes.NewReader(frame.JPEG))
		if err != nil || config.Width > 256 || config.Height > 256 || len(frame.JPEG) > MaxFrameBytes {
			t.Fatalf("frame=%+v err=%v", config, err)
		}
	}
	if _, err := ExtractVideoFrames(context.Background(), sample, 5, 256); err == nil {
		t.Fatal("accepted too many frames")
	}
	link := filepath.Join(t.TempDir(), "link.mov")
	if err := os.Symlink(sample, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ExtractVideoFrames(context.Background(), link, 1, 256); err == nil {
		t.Fatal("accepted video symlink")
	}
}

func TestPDFKitPreviewIsBounded(t *testing.T) {
	requireSwift(t)
	path := filepath.Join(t.TempDir(), "fixture.pdf")
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 200 Td (Hello Lake) Tj ET\nendstream",
	}
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	if err := os.WriteFile(path, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	preview, err := ExtractPDFPreview(context.Background(), path)
	if err != nil || preview.Pages != 1 || len(preview.JPEG) == 0 {
		t.Fatalf("pages=%d jpeg_bytes=%d err=%v", preview.Pages, len(preview.JPEG), err)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(preview.JPEG))
	if err != nil || config.Width > 768 || config.Height > 768 {
		t.Fatalf("config=%+v err=%v", config, err)
	}
	link := filepath.Join(t.TempDir(), "link.pdf")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ExtractPDFPreview(context.Background(), link); err == nil {
		t.Fatal("accepted PDF symlink")
	}
}
