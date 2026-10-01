//go:build darwin

package media

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed video_frames.swift
var videoFramesSwift []byte

// ExtractVideoFrames asks macOS AVFoundation to decode evenly spaced frames.
// The Swift helper receives paths as argv and has no Lake credentials.
func ExtractVideoFrames(ctx context.Context, path string, count, dimension int) ([]VideoFrame, error) {
	if err := validateVideoLimits(count, dimension); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("视频路径必须是绝对路径")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > MaxVideoBytes {
		return nil, errors.New("视频必须是不超过 100 MiB 的普通文件，不能是符号链接")
	}
	swift, err := exec.LookPath("swift")
	if err != nil {
		return nil, errors.New("系统 Swift/AVFoundation 解码器不可用")
	}
	work, err := os.MkdirTemp("", "lake-video-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	if err := os.Chmod(work, 0700); err != nil {
		return nil, err
	}
	helper := filepath.Join(work, "video_frames.swift")
	if err := os.WriteFile(helper, videoFramesSwift, 0600); err != nil {
		return nil, err
	}
	decodeCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	command := exec.CommandContext(decodeCtx, swift, helper, path, work, strconv.Itoa(count), strconv.Itoa(dimension))
	// Keep compiler diagnostics bounded; never include the video bytes.
	output, err := command.CombinedOutput()
	if decodeCtx.Err() != nil {
		return nil, fmt.Errorf("视频解码超时或取消: %w", decodeCtx.Err())
	}
	if err != nil {
		return nil, fmt.Errorf("系统视频解码失败: %s", strings.TrimSpace(string(output[:min(len(output), 2048)])))
	}
	lines := strings.Fields(strings.TrimSpace(string(output)))
	if len(lines) == 0 {
		return nil, errors.New("视频解码器未返回时长")
	}
	duration, err := strconv.ParseFloat(lines[len(lines)-1], 64)
	if err != nil || duration <= 0 || duration > 300 {
		return nil, errors.New("视频时长必须在 0–300 秒之间")
	}
	frames := make([]VideoFrame, 0, count)
	for i := 0; i < count; i++ {
		name := filepath.Join(work, fmt.Sprintf("frame-%02d.jpg", i+1))
		file, err := os.Open(name)
		if err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > MaxFrameBytes {
			file.Close()
			return nil, errors.New("视频帧无效或超过 1 MiB")
		}
		data, err := io.ReadAll(io.LimitReader(file, MaxFrameBytes+1))
		file.Close()
		if err != nil || len(data) == 0 || len(data) > MaxFrameBytes {
			return nil, errors.New("视频帧读取失败或超过 1 MiB")
		}
		if len(data) < 3 || data[0] != 0xff || data[1] != 0xd8 || data[2] != 0xff {
			return nil, errors.New("视频帧不是 JPEG")
		}
		frames = append(frames, VideoFrame{AtSeconds: duration * float64(i+1) / float64(count+1), JPEG: data})
	}
	return frames, nil
}
