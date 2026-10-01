package main

import (
	"fmt"
	"io"
	"sync"
	"time"
)

var progressFrames = [...]string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// terminalProgress keeps a single transient line visible while Lake is busy.
// All writes are serialized so a confirmation prompt can pause the animation.
type terminalProgress struct {
	out     io.Writer
	enabled bool
	mu      sync.Mutex
	active  bool
	paused  bool
	label   string
	started time.Time
	frame   int
	stop    chan struct{}
	done    chan struct{}
}

func newTerminalProgress(out io.Writer, enabled bool) *terminalProgress {
	return &terminalProgress{out: out, enabled: enabled}
}

func (p *terminalProgress) Start(label string) {
	if p == nil || !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active {
		return
	}
	p.active, p.paused = true, false
	p.label, p.started, p.frame = label, time.Now(), 0
	p.stop, p.done = make(chan struct{}), make(chan struct{})
	p.renderLocked()
	go p.animate(p.stop, p.done)
}

func (p *terminalProgress) animate(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(120 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			p.mu.Lock()
			if p.active && !p.paused {
				p.frame++
				p.renderLocked()
			}
			p.mu.Unlock()
		}
	}
}

func (p *terminalProgress) Pause() {
	if p == nil || !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active && !p.paused {
		p.paused = true
		p.clearLocked()
	}
}

func (p *terminalProgress) Resume() {
	if p == nil || !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active && p.paused {
		p.paused = false
		p.renderLocked()
	}
}

func (p *terminalProgress) SetLabel(label string) {
	if p == nil || !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.active || p.label == label {
		return
	}
	p.label = label
	if !p.paused {
		p.renderLocked()
	}
}

func (p *terminalProgress) Stop() {
	if p == nil || !p.enabled {
		return
	}
	p.mu.Lock()
	if !p.active {
		p.mu.Unlock()
		return
	}
	p.active = false
	close(p.stop)
	done := p.done
	if !p.paused {
		p.clearLocked()
	}
	p.mu.Unlock()
	<-done
}

func (p *terminalProgress) renderLocked() {
	_, _ = fmt.Fprintf(p.out, "\r\x1b[2K%s %s · %.1f 秒",
		progressFrames[p.frame%len(progressFrames)], p.label, time.Since(p.started).Seconds())
}

func (p *terminalProgress) clearLocked() {
	_, _ = io.WriteString(p.out, "\r\x1b[2K")
}
