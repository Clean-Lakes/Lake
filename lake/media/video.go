package media

import "errors"

const (
	MaxVideoBytes     = 100 << 20
	MaxFrames         = 4
	MaxFrameDimension = 768
	MaxFrameBytes     = 1 << 20
)

type VideoFrame struct {
	AtSeconds float64
	JPEG      []byte
}

func validateVideoLimits(count, dimension int) error {
	if count < 1 || count > MaxFrames || dimension < 64 || dimension > MaxFrameDimension {
		return errors.New("视频最多提取 4 帧，每帧最长边须在 64–768 像素之间")
	}
	return nil
}
