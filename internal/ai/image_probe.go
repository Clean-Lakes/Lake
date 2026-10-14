package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"time"
)

// ProbeImageInput checks whether the provider accepts an actual image request.
// A nil result means the request failed for a reason unrelated to image support.
func ProbeImageInput(ctx context.Context, model Model) (*bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			img.Set(x, y, color.RGBA{B: 255, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		return nil, err
	}
	model.SupportsImageInput = true
	model.SupportsImageOutput = false
	model.MaxOutput = 64
	attachment := ImageAttachment{ID: "lake-image-probe", Name: "lake-image-probe.png", MimeType: "image/png", Base64: base64.StdEncoding.EncodeToString(encoded.Bytes())}
	response, err := Stream(ctx, model, []Message{{Role: "user", Content: "What is the color of this image? Reply with one English word.", Images: []ImageAttachment{attachment}}}, nil, nil)
	if err == nil {
		answer := strings.ToLower(strings.Trim(strings.TrimSpace(response.Message.Content), " \t\r\n.。!！\"'`"))
		if answer == "blue" {
			value := true
			return &value, nil
		}
		return nil, nil
	}
	message := strings.ToLower(err.Error())
	imageRelated := strings.Contains(message, "image") || strings.Contains(message, "vision") || strings.Contains(message, "multimodal") || strings.Contains(message, "图片") || strings.Contains(message, "视觉")
	unsupported := strings.Contains(message, "not support") || strings.Contains(message, "unsupported") || strings.Contains(message, "doesn't support") || strings.Contains(message, "cannot accept") || strings.Contains(message, "不支持")
	if imageRelated && unsupported {
		value := false
		return &value, nil
	}
	return nil, err
}
