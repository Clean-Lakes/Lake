package media

type PDFPreview struct {
	Pages     int    `json:"pages"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	JPEG      []byte `json:"-"`
}
