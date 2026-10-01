package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"

	"LakeDesktop/internal/media"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// PickVideoFrames keeps the original local video out of WebView and Lake DB.
// Only bounded JPEG frames cross the desktop bridge for model input.
func (a *App) PickVideoFrames(count int) (string, error) {
	path, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "选择视频提取关键帧"})
	if err != nil || path == "" {
		return "", err
	}
	frames, err := media.ExtractVideoFrames(a.ctx, path, count, media.MaxFrameDimension)
	if err != nil {
		return "", err
	}
	images := make([]ImageAttachment, 0, len(frames))
	for _, frame := range frames {
		images = append(images, ImageAttachment{Name: fmt.Sprintf("%s · %.1f 秒", filepath.Base(path), frame.AtSeconds), MIMEType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(frame.JPEG)})
	}
	data, err := json.Marshal(images)
	return string(data), err
}

func (a *App) PickPDFPreview() (string, error) {
	path, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "选择 PDF 预览"})
	if err != nil || path == "" {
		return "", err
	}
	preview, err := media.ExtractPDFPreview(a.ctx, path)
	if err != nil {
		return "", err
	}
	image := ImageAttachment{Name: filepath.Base(path) + " · 第 1 页", MIMEType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(preview.JPEG)}
	data, err := json.Marshal(struct {
		Name      string          `json:"name"`
		Pages     int             `json:"pages"`
		Text      string          `json:"text"`
		Truncated bool            `json:"truncated"`
		Image     ImageAttachment `json:"image"`
	}{filepath.Base(path), preview.Pages, preview.Text, preview.Truncated, image})
	return string(data), err
}
