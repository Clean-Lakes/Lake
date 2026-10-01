//go:build darwin

package media

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed pdf_preview.swift
var pdfPreviewSwift []byte

// ExtractPDFPreview renders page one and extracts bounded text from at most ten
// pages using macOS PDFKit. Embedded PDF actions are never executed.
func ExtractPDFPreview(ctx context.Context, path string) (PDFPreview, error) {
	if !filepath.IsAbs(path) || strings.ToLower(filepath.Ext(path)) != ".pdf" {
		return PDFPreview{}, errors.New("需要 PDF 绝对路径")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return PDFPreview{}, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 8<<20 {
		return PDFPreview{}, errors.New("PDF 必须是不超过 8 MiB 的普通文件")
	}
	swift, err := exec.LookPath("swift")
	if err != nil {
		return PDFPreview{}, errors.New("系统 Swift/PDFKit 解码器不可用")
	}
	work, err := os.MkdirTemp("", "lake-pdf-*")
	if err != nil {
		return PDFPreview{}, err
	}
	defer os.RemoveAll(work)
	if err := os.Chmod(work, 0700); err != nil {
		return PDFPreview{}, err
	}
	helper := filepath.Join(work, "pdf_preview.swift")
	if err := os.WriteFile(helper, pdfPreviewSwift, 0600); err != nil {
		return PDFPreview{}, err
	}
	decodeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(decodeCtx, swift, helper, path, work).CombinedOutput()
	if decodeCtx.Err() != nil {
		return PDFPreview{}, fmt.Errorf("PDF 预览超时或取消: %w", decodeCtx.Err())
	}
	if err != nil {
		return PDFPreview{}, fmt.Errorf("PDF 预览失败: %s", strings.TrimSpace(string(output[:min(len(output), 2048)])))
	}
	meta, err := os.ReadFile(filepath.Join(work, "preview.json"))
	if err != nil || len(meta) > 128<<10 {
		return PDFPreview{}, errors.New("PDF 预览元数据无效")
	}
	var result PDFPreview
	if err := json.Unmarshal(meta, &result); err != nil || result.Pages < 1 || len(result.Text) > 64<<10 {
		return PDFPreview{}, errors.New("PDF 预览内容无效")
	}
	file, err := os.Open(filepath.Join(work, "preview.jpg"))
	if err != nil {
		return PDFPreview{}, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() == 0 || stat.Size() > MaxFrameBytes {
		return PDFPreview{}, errors.New("PDF 预览图无效")
	}
	result.JPEG, err = io.ReadAll(io.LimitReader(file, MaxFrameBytes+1))
	if err != nil || len(result.JPEG) < 3 || len(result.JPEG) > MaxFrameBytes || result.JPEG[0] != 0xff || result.JPEG[1] != 0xd8 || result.JPEG[2] != 0xff {
		return PDFPreview{}, errors.New("PDF 预览图不是有界 JPEG")
	}
	return result, nil
}
