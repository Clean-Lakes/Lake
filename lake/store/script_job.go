package store

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"golang.org/x/sys/unix"
)

var scriptJobID = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ScriptJob contains immutable execution identity, never script text or secrets.
type ScriptJob struct {
	ID             string    `json:"id"`
	LakeID         string    `json:"lake_id"`
	ResourceID     string    `json:"resource_id"`
	ScriptID       string    `json:"script_id"`
	ScriptSHA256   string    `json:"script_sha256"`
	TargetSHA256   string    `json:"target_sha256"`
	Language       string    `json:"language"`
	TimeoutSeconds int       `json:"timeout_seconds"`
	CreatedAt      time.Time `json:"created_at"`
}

func ValidScriptJobID(id string) bool { return scriptJobID.MatchString(id) }

func (s *Store) scriptJobDir() (string, error) {
	p := filepath.Join(s.root, "script-jobs")
	if err := os.MkdirAll(p, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(p)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return "", errors.New("脚本任务目录权限无效")
	}
	return p, nil
}

func (s *Store) SaveScriptJob(job ScriptJob) error {
	if !ValidScriptJobID(job.ID) || job.LakeID == "" || job.ResourceID == "" || job.ScriptID == "" || len(job.ScriptSHA256) != 64 || len(job.TargetSHA256) != 64 || (job.Language != "sh" && job.Language != "bash") || job.TimeoutSeconds < 1 || job.TimeoutSeconds > 86400 {
		return errors.New("脚本任务身份无效")
	}
	dir, err := s.scriptJobDir()
	if err != nil {
		return err
	}
	b, err := json.Marshal(job)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".job-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Link installs once without overwriting an existing job or following links.
	if err = os.Link(f.Name(), filepath.Join(dir, job.ID+".json")); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *Store) GetScriptJob(id string) (ScriptJob, error) {
	var job ScriptJob
	if !ValidScriptJobID(id) {
		return job, errors.New("脚本任务 ID 无效")
	}
	dir, err := s.scriptJobDir()
	if err != nil {
		return job, err
	}
	fd, err := unix.Open(filepath.Join(dir, id+".json"), unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		return job, ErrNotFound
	}
	if err != nil {
		return job, err
	}
	f := os.NewFile(uintptr(fd), "script-job")
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return job, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 8192 {
		return job, errors.New("脚本任务文件权限或大小无效")
	}
	b, err := io.ReadAll(io.LimitReader(f, 8193))
	if err != nil {
		return job, err
	}
	if json.Unmarshal(b, &job) != nil || job.ID != id || job.LakeID == "" || job.ResourceID == "" || len(job.TargetSHA256) != 64 || len(job.ScriptSHA256) != 64 {
		return ScriptJob{}, errors.New("脚本任务内容无效")
	}
	return job, nil
}

func (s *Store) ListScriptJobs(lakeID string) ([]ScriptJob, error) {
	dir, err := s.scriptJobDir()
	if err != nil {
		return nil, err
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	jobs := []ScriptJob{}
	for _, f := range files {
		name := f.Name()
		if len(name) != 37 || name[32:] != ".json" {
			continue
		}
		job, err := s.GetScriptJob(name[:32])
		if err != nil {
			return nil, err
		}
		if job.LakeID == lakeID {
			jobs = append(jobs, job)
		}
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt.After(jobs[j].CreatedAt) })
	if len(jobs) > 100 {
		jobs = jobs[:100]
	}
	return jobs, nil
}
