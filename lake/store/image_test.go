package store

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestValidateImagesRejectsMalformedAndOversizedInput(t *testing.T) {
	valid := ImageAttachment{MIMEType: "image/png", Data: base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nimage"))}
	for name, images := range map[string][]ImageAttachment{
		"malformed":  {{MIMEType: "image/png", Data: "not base64"}},
		"wrong type": {{MIMEType: "image/jpeg", Data: valid.Data}},
		"too many":   {valid, valid, valid, valid, valid},
		"too large":  {{MIMEType: "image/png", Data: strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxImageBytes)+4)}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateImages(images); err == nil {
				t.Fatal("expected image validation error")
			}
		})
	}
}
