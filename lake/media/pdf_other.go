//go:build !darwin

package media

import (
	"context"
	"errors"
)

func ExtractPDFPreview(context.Context, string) (PDFPreview, error) {
	return PDFPreview{}, errors.New("PDF 附件预览仅支持 macOS")
}
