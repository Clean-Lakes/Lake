//go:build !darwin

package media

import (
	"context"
	"errors"
)

func ExtractVideoFrames(context.Context, string, int, int) ([]VideoFrame, error) {
	return nil, errors.New("视频帧提取仅支持 macOS")
}
