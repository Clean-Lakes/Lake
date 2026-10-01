package tools

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudwego/eino/lake/media"
	"github.com/cloudwego/eino/lake/store"
)

// VideoImages decodes user-selected local video into bounded model images.
// The original video never enters the model context or Lake database.
func VideoImages(ctx context.Context, absolutePath string) ([]store.ImageAttachment, error) {
	return VideoImagesCount(ctx, absolutePath, media.MaxFrames)
}

func VideoImagesCount(ctx context.Context, absolutePath string, count int) ([]store.ImageAttachment, error) {
	frames, err := media.ExtractVideoFrames(ctx, absolutePath, count, media.MaxFrameDimension)
	if err != nil {
		return nil, err
	}
	name := filepath.Base(absolutePath)
	name = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, name)
	if len(name) > 100 {
		name = name[:100]
	}
	images := make([]store.ImageAttachment, 0, len(frames))
	for _, frame := range frames {
		images = append(images, store.ImageAttachment{Name: fmt.Sprintf("%s · %.1f 秒", name, frame.AtSeconds), MIMEType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(frame.JPEG)})
	}
	if err := store.ValidateImages(images); err != nil {
		return nil, err
	}
	return images, nil
}

func VideoImagesInProject(ctx context.Context, root, relative string) ([]store.ImageAttachment, error) {
	if root == "" || relative == "" || filepath.IsAbs(relative) || strings.ContainsAny(relative, "\x00\r\n") || filepath.Clean(relative) != relative || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, errors.New("视频路径必须在代码项目内")
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(canonicalRoot, relative)
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	inside, err := filepath.Rel(canonicalRoot, canonical)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return nil, errors.New("视频路径超出代码项目")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("视频不能是符号链接")
	}
	return VideoImages(ctx, canonical)
}
