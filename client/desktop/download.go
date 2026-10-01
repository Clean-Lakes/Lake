package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const maxDownloadBytes = 8 * 1024 * 1024

// SaveDownload uses the native save panel because WebView download links do not
// provide a desktop file-saving path. Only the user's selected path is written.
func (a *App) SaveDownload(filename, mimeType, encoded string) (string, error) {
	extensions := map[string]string{
		"application/json": ".json", "image/png": ".png", "image/jpeg": ".jpg",
		"image/webp": ".webp", "image/gif": ".gif",
	}
	extension, ok := extensions[mimeType]
	if !ok || filename == "" || len(filename) > 180 || strings.ContainsAny(filename, "/\\:\x00\r\n") || !strings.HasSuffix(strings.ToLower(filename), extension) {
		return "", errors.New("无效的下载文件名或类型")
	}
	if len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(maxDownloadBytes) {
		return "", errors.New("下载内容为空或超过 8 MB")
	}
	content, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(content) == 0 || len(content) > maxDownloadBytes {
		return "", errors.New("下载内容编码无效")
	}
	if mimeType == "application/json" && !json.Valid(content) {
		return "", errors.New("下载的 JSON 内容无效")
	}
	options := wailsruntime.SaveDialogOptions{
		Title: "保存下载文件", DefaultFilename: filename, CanCreateDirectories: true,
		Filters: []wailsruntime.FileFilter{{DisplayName: strings.TrimPrefix(extension, ".") + " 文件", Pattern: "*" + extension}},
	}
	var path string
	if a.saveDownloadDialog != nil {
		path, err = a.saveDownloadDialog(options)
	} else {
		path, err = wailsruntime.SaveFileDialog(a.ctx, options)
	}
	if err != nil {
		return "", fmt.Errorf("打开保存窗口失败: %w", err)
	}
	if path == "" {
		return "", nil // Cancellation is not a successful download.
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("保存位置必须为绝对路径")
	}
	if err := writeDownload(path, content); err != nil {
		return "", fmt.Errorf("保存文件失败: %w", err)
	}
	return path, nil
}

// Write beside the selected file, then replace it after a complete write. A
// failed download must not truncate an existing file selected in the save panel.
func writeDownload(path string, content []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".lake-download-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
