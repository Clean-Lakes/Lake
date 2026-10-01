package store

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
)

const MaxImageBytes = 2 << 20
const MaxImagesPerTurn = 4

// ImageAttachment contains base64 image bytes, without a data URL prefix.
type ImageAttachment struct {
	Name     string `json:"name,omitempty"`
	MIMEType string `json:"mime_type"`
	Data     string `json:"data"`
}

func ValidateImages(images []ImageAttachment) error {
	if len(images) > MaxImagesPerTurn {
		return fmt.Errorf("每轮最多上传 %d 张图片", MaxImagesPerTurn)
	}
	for i, image := range images {
		if len(image.Data) == 0 || len(image.Data) > base64.StdEncoding.EncodedLen(MaxImageBytes) {
			return fmt.Errorf("第 %d 张图片超过 2 MB 或为空", i+1)
		}
		decoded, err := base64.StdEncoding.DecodeString(image.Data)
		if err != nil || len(decoded) == 0 || len(decoded) > MaxImageBytes {
			return fmt.Errorf("第 %d 张图片内容无效或超过 2 MB", i+1)
		}
		detected := http.DetectContentType(decoded)
		if detected != image.MIMEType || !supportedImageType(image.MIMEType) {
			return fmt.Errorf("第 %d 张图片的格式与内容不匹配", i+1)
		}
	}
	return nil
}

func supportedImageType(value string) bool {
	switch value {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

var ErrImageModelUnsupported = errors.New("当前模型不支持图片输入，请切换到 deepseek-flash")
