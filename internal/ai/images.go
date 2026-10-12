package ai

import (
	"bytes"
	"encoding/base64"
	"errors"
	_ "golang.org/x/image/webp"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

type ImageAttachment struct {
	ID        string `json:"id"`
	MimeType  string `json:"mimeType"`
	Base64    string `json:"base64"`
	SizeBytes int    `json:"sizeBytes"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Name      string `json:"name,omitempty"`
}

func ValidateImages(images []ImageAttachment) ([]ImageAttachment, error) {
	if len(images) > 4 {
		return nil, errors.New("at most four images per message")
	}
	ids := map[string]bool{}
	total := 0
	out := []ImageAttachment{}
	for _, img := range images {
		if len(img.Base64) > 3<<20 {
			return nil, errors.New("image exceeds 2 MiB")
		}
		b, err := base64.StdEncoding.DecodeString(img.Base64)
		if err != nil || len(b) == 0 || len(b) > 2<<20 {
			return nil, errors.New("invalid image data or size")
		}
		total += len(b)
		if total > 4<<20 {
			return nil, errors.New("images exceed total 4 MiB limit")
		}
		config, format, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 8192 || config.Height > 8192 || config.Width*config.Height > 16000000 {
			return nil, errors.New("unsupported image or dimensions")
		}
		mime := "image/" + format
		if format == "jpeg" {
			mime = "image/jpeg"
		}
		if img.MimeType != "" && img.MimeType != mime {
			return nil, errors.New("image MIME does not match its bytes")
		}
		img.MimeType = mime
		img.SizeBytes = len(b)
		img.Width = config.Width
		img.Height = config.Height
		if img.ID == "" {
			img.ID = uid()
		}
		if !identifier.MatchString(img.ID) || ids[img.ID] {
			return nil, errors.New("invalid or duplicate image id")
		}
		ids[img.ID] = true
		if len(img.Name) > 200 {
			img.Name = img.Name[:200]
		}
		out = append(out, img)
	}
	return out, nil
}
func imageURL(img ImageAttachment) string { return "data:" + img.MimeType + ";base64," + img.Base64 }
func parseImageURL(value string) (ImageAttachment, bool) {
	if !strings.HasPrefix(value, "data:image/") {
		return ImageAttachment{}, false
	}
	parts := strings.SplitN(value, ";base64,", 2)
	if len(parts) != 2 {
		return ImageAttachment{}, false
	}
	images, err := ValidateImages([]ImageAttachment{{MimeType: strings.TrimPrefix(parts[0], "data:"), Base64: parts[1]}})
	if err != nil {
		return ImageAttachment{}, false
	}
	return images[0], true
}
func historyCost(history []Message) int {
	total := 0
	for _, m := range history {
		copy := m
		copy.Images = nil
		copy.Native = nil
		total += len(js(copy))
		total += len(m.Images) * 8192
	}
	return total
}
func summaryMessages(history []Message) []Message {
	out := []Message{}
	for _, m := range history {
		m.Native = nil
		if len(m.Images) > 0 {
			images := append([]ImageAttachment(nil), m.Images...)
			for i := range images {
				images[i].Base64 = ""
			}
			m.Images = images
		}
		out = append(out, m)
	}
	return out
}
