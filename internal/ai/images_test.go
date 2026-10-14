package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func fixtureImage(t *testing.T) ImageAttachment {
	t.Helper()
	var b bytes.Buffer
	if png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 3))) != nil {
		t.Fatal("PNG encode")
	}
	return ImageAttachment{ID: "image-fixture", MimeType: "image/png", Base64: base64.StdEncoding.EncodeToString(b.Bytes()), Name: "fixture.png"}
}
func TestImageValidationAndSixProtocolPayloads(t *testing.T) {
	img := fixtureImage(t)
	images, err := ValidateImages([]ImageAttachment{img})
	if err != nil || images[0].Width != 2 || images[0].Height != 3 {
		t.Fatal(images, err)
	}
	for _, p := range []string{"openai", "azure-gpt", "openai-response", "claude", "gemini", "ollama"} {
		_, body, err := modelPayload(Model{URL: "http://localhost/test", Name: "vision", Protocol: p, SupportsImageInput: true}, []Message{{Role: "user", Content: "inspect", Images: images}}, nil)
		if err != nil || !strings.Contains(js(body), img.Base64) {
			t.Fatal(p, body, err)
		}
	}
	if _, err := ValidateImages([]ImageAttachment{img, img}); err == nil {
		t.Fatal("duplicate image accepted")
	}
	img.MimeType = "image/jpeg"
	if _, err := ValidateImages([]ImageAttachment{img}); err == nil {
		t.Fatal("wrong MIME accepted")
	}
	img.MimeType = "image/png"
	img.Base64 = base64.StdEncoding.EncodeToString([]byte("not an image"))
	if _, err := ValidateImages([]ImageAttachment{img}); err == nil {
		t.Fatal("non-image accepted")
	}
}

func TestImageOnlyInputAndOpenAIResponsePayload(t *testing.T) {
	image := fixtureImage(t)
	if err := (TurnInput{Images: []ImageAttachment{image}}).validate(); err != nil {
		t.Fatal(err)
	}
	if err := (TurnInput{}).validate(); err == nil {
		t.Fatal("empty turn accepted")
	}
	for _, protocol := range []string{"openai", "openai-response"} {
		_, body, err := modelPayload(Model{URL: "http://localhost/test", Name: "vision", Protocol: protocol, SupportsImageInput: true}, []Message{{Role: "user", Images: []ImageAttachment{image}}}, nil)
		if err != nil || !strings.Contains(js(body), image.Base64) || strings.Contains(js(body), `"text":""`) {
			t.Fatal(protocol, err)
		}
	}
}
func TestNativeImageOutputAndHistory(t *testing.T) {
	img := fixtureImage(t)
	m, close := fakeModel(t, func(_ int, _ map[string]any) any {
		return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "observed", "images": []any{map[string]any{"image_url": map[string]any{"url": imageURL(img)}}}}}}}
	})
	defer close()
	m.SupportsImageInput = true
	e := engineFor(t, m, nil)
	if err := e.ChatImages(context.Background(), "case", "inspect", nil, []ImageAttachment{img}); err != nil {
		t.Fatal(err)
	}
	history, _ := e.History("case")
	if len(history[1].Images) != 1 || len(history[2].Images) != 1 {
		t.Fatal("image history missing")
	}
	view, _ := e.Snapshot("case")
	found := false
	for _, card := range view.Cards {
		if card.Type == "image" {
			found = true
		}
	}
	if !found {
		t.Fatal("image output card missing")
	}
	m.SupportsImageInput = false
	e2 := engineFor(t, m, nil)
	if e2.ChatImages(context.Background(), "case", "inspect", nil, []ImageAttachment{img}) == nil {
		t.Fatal("undeclared image capability accepted")
	}
	a := newAccumulator("gemini", nil)
	if err := a.consume(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": img.Base64}}}}, "finishReason": "STOP"}}}, false); err != nil {
		t.Fatal(err)
	}
	result, err := a.finish()
	if err != nil || len(result.Message.Images) != 1 {
		t.Fatal(result, err)
	}
}
