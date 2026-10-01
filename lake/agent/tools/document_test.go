package tools

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestPDF(t *testing.T, path string) {
	t.Helper()
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
	for i, obj := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, obj)
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
}

func TestReadPDFExtractsBoundedTextAndRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	writeTestPDF(t, filepath.Join(root, "report.pdf"))
	result, err := ReadPDF(root, "report.pdf", 1, 1)
	if err != nil || !strings.Contains(result.Text, "HelloLake") || result.Pages != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if err := os.Symlink(filepath.Join(root, "report.pdf"), filepath.Join(root, "link.pdf")); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPDF(root, "link.pdf", 1, 1); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := ReadPDF(root, "../report.pdf", 1, 1); err == nil {
		t.Fatal("project escape accepted")
	}
}
