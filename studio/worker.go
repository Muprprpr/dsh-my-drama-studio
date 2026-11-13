package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
)

// Provider adapts a verified service. Calls must honor ctx. Its submit method
// must only report Rejected when the service definitively created no task.
type Provider interface {
	Submit(context.Context, GenerationInput) (ProviderSubmission, error)
	Poll(context.Context, string) (ProviderResult, error)
	Download(context.Context, ProviderResult, io.Writer) error
}

type GenerationInput struct {
	Type            string                `json:"type"`
	Prompt          string                `json:"prompt"`
	Mode            string                `json:"mode,omitempty"`
	Profile         ProviderProfile       `json:"profile,omitzero"`
	WorkspacePath   string                `json:"-"`
	References      []GenerationReference `json:"references,omitempty"`
	Params          VideoParams           `json:"params,omitzero"`
	OutputDirectory string                `json:"outputDirectory,omitempty"`
}

type sourceGroup struct {
	EpisodeID string `json:"episodeId"`
	SceneID   string `json:"sceneId"`
	ShotID    string `json:"shotId"`
}

type generationRequest struct {
	GenerationInput
	SourceGroup   *sourceGroup `json:"sourceGroup,omitempty"`
	SourceNodeIDs []string     `json:"sourceNodeIds,omitempty"`
}

func readSourceGroup(ctx context.Context, tx *sql.Tx, id string) (sourceGroup, error) {
	var group sourceGroup
	err := tx.QueryRowContext(ctx, "SELECT episode_id,scene_id,shot_id FROM nodes WHERE id=?", id).
		Scan(&group.EpisodeID, &group.SceneID, &group.ShotID)
	return group, err
}

type GenerationReference struct {
	Type string `json:"type"`
	URL  string `json:"url,omitempty"`
	Path string `json:"path,omitempty"`
}

type ProviderSubmission struct {
	TaskID   string
	Rejected bool
}

type ProviderResult struct {
	Status    string // pending, running, succeeded, failed, cancelled
	URL       string
	Extension string // e.g. .png, .mp4
	Error     string
}

func (s *Service) wakeWorker() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

type jobKey struct {
	project *project
	id      string
}

type generationJob struct {
	jobKey
	status    string
	createdAt string
}

const runnableTasks = "status IN ('pending','submitting','polling')"
const taskOrder = "CASE status WHEN 'submitting' THEN 0 WHEN 'polling' THEN 1 ELSE 2 END, created_at, rowid"
const maxWorkerSlots = 32

// Run owns the local concurrency slots. A slot stays occupied through polling and download.
func (s *Service) Run(ctx context.Context) {
	if s.provider == nil {
		return
	}
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()
	finished := make(chan jobKey, maxWorkerSlots)
	active := make(map[jobKey]bool)
	var workers sync.WaitGroup
	defer workers.Wait()
	for ctx.Err() == nil {
		limit := 2
		if settings, ok := s.provider.(interface{ MaxConcurrent() int }); ok {
			limit = min(maxWorkerSlots, max(1, settings.MaxConcurrent()))
		}
		if slots := limit - len(active); slots > 0 {
			// Another worker may own the first tasks listed for this workspace.
			for _, job := range s.generationJobs(ctx, limit+maxWorkerSlots) {
				if slots == 0 {
					break
				}
				if active[job.jobKey] {
					continue
				}
				release, err := job.project.tryTaskLock(job.id)
				if err != nil {
					log.Printf("Studio task lock: %s", (videoHTTP{}).safeMessage(err.Error()))
					continue
				}
				if release == nil {
					continue
				}
				active[job.jobKey] = true
				slots--
				workers.Go(func() {
					defer func() {
						release()
						select {
						case finished <- job.jobKey:
						case <-ctx.Done():
						}
					}()
					if err := job.project.runGeneration(ctx, s.provider, job.id, s.pollInterval, s.pollTimeout); err != nil && ctx.Err() == nil {
						log.Printf("Studio task worker: %s", (videoHTTP{}).safeMessage(err.Error()))
					}
				})
			}
		}
		select {
		case <-ctx.Done():
		case key := <-finished:
			delete(active, key)
		case <-ticker.C:
		case <-s.wake:
		}
	}
}

func (s *Service) generationJobs(ctx context.Context, limit int) []generationJob {
	s.mu.Lock()
	projects := make([]*project, 0, len(s.projects))
	for _, p := range s.projects {
		projects = append(projects, p)
	}
	s.mu.Unlock()
	var jobs []generationJob
	for _, p := range projects {
		rows, err := p.db.QueryContext(ctx, "SELECT id,status,created_at FROM tasks WHERE "+runnableTasks+" ORDER BY "+taskOrder+" LIMIT ?", limit)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("Studio task listing: %v", err)
			}
			continue
		}
		for rows.Next() {
			job := generationJob{jobKey: jobKey{project: p}}
			if err := rows.Scan(&job.id, &job.status, &job.createdAt); err == nil {
				jobs = append(jobs, job)
			}
		}
		_ = rows.Close()
	}
	slices.SortFunc(jobs, func(a, b generationJob) int {
		if (a.status == "pending") != (b.status == "pending") {
			if a.status == "pending" {
				return 1
			}
			return -1
		}
		return strings.Compare(a.createdAt, b.createdAt)
	})
	return jobs
}

func (p *project) runGeneration(ctx context.Context, registry providerRegistry, id string, interval, timeout time.Duration) error {
	var deadline time.Time
	var onCompleted func()
	for ctx.Err() == nil {
		task, input, err := scanTask(p.db.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=?", id))
		if err != nil {
			return err
		}
		switch task.Status {
		case "pending", "submitting":
		case "polling":
			if deadline.IsZero() {
				deadline = time.Now().Add(timeout)
			} else if time.Now().After(deadline) {
				return p.transition(ctx, task, "paused", task.ProviderTaskID, "等待上游结果超时，可以继续查询")
			}
		default:
			return nil
		}
		if err := p.advanceTask(ctx, registry, task, input, deadline, &onCompleted); err != nil {
			return err
		}
		delay := interval
		if !deadline.IsZero() {
			delay = min(interval, time.Until(deadline))
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return ctx.Err()
}

func (p *project) advance(ctx context.Context, registry providerRegistry) error {
	task, input, err := scanTask(p.db.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE "+runnableTasks+" ORDER BY "+taskOrder+" LIMIT 1"))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var onCompleted func()
	return p.advanceTask(ctx, registry, task, input, time.Time{}, &onCompleted)
}

func (p *project) advanceTask(ctx context.Context, registry providerRegistry, task Task, input string, deadline time.Time, onCompleted *func()) error {
	var request generationRequest
	var provider Provider
	if task.Status != "submitting" {
		if err := json.Unmarshal([]byte(input), &request); err != nil {
			return p.transition(ctx, task, "failed", task.ProviderTaskID, "Stored generation request is invalid")
		}
		request.WorkspacePath = p.dir
		var err error
		provider, err = registry.Resolve(request.Profile)
		if err != nil {
			next := "failed"
			if task.ProviderTaskID != "" {
				next = "paused"
			}
			return p.transition(ctx, task, next, task.ProviderTaskID, "渠道凭据不可用，请检查 Drama Studio 设置")
		}
	}
	switch task.Status {
	case "pending":
		if err := p.transition(ctx, task, "submitting", "", ""); err != nil {
			return err
		}
		task.Status = "submitting"
		call, cancelCall := context.WithTimeout(ctx, 60*time.Second)
		reply, submitErr := provider.Submit(call, request.GenerationInput)
		cancelCall()
		persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if strings.TrimSpace(reply.TaskID) != "" {
			if err := p.transition(persist, task, "polling", reply.TaskID, ""); err != nil {
				return err
			}
			if resolved, ok := provider.(*resolvedChannelProvider); ok {
				*onCompleted = resolved.onCompleted
			}
			return nil
		}
		message := "Submission outcome unknown. Confirm with provider before submitting again."
		if reply.Rejected {
			message = "Provider rejected submission."
		}
		if errors.Is(submitErr, context.DeadlineExceeded) {
			message += " The submission response timed out."
		} else if submitErr != nil {
			message += " " + (videoHTTP{}).safeMessage(submitErr.Error())
		}
		if reply.Rejected {
			return p.transition(persist, task, "failed", "", message)
		}
		return p.transition(persist, task, "uncertain", "", message)
	case "submitting":
		if task.ProviderTaskID != "" {
			return p.transition(ctx, task, "polling", task.ProviderTaskID, "")
		}
		return p.transition(ctx, task, "uncertain", "", "Studio stopped before the provider task ID was saved. Confirm with provider before submitting again.")
	case "polling":
		budget := 30 * time.Second
		if !deadline.IsZero() {
			budget = min(budget, time.Until(deadline))
		}
		call, cancel := context.WithTimeout(ctx, budget)
		result, err := provider.Poll(call, task.ProviderTaskID)
		cancel()
		if err != nil {
			return p.providerTaskError(ctx, task, err)
		}
		switch result.Status {
		case "pending", "running":
			return p.transition(ctx, task, "polling", task.ProviderTaskID, "")
		case "failed":
			message := (videoHTTP{}).safeMessage(result.Error)
			if message == "" {
				message = "上游服务报告生成失败"
			}
			return p.transition(ctx, task, "failed", task.ProviderTaskID, message)
		case "cancelled":
			return p.transition(ctx, task, "cancelled", task.ProviderTaskID, (videoHTTP{}).safeMessage(result.Error))
		case "succeeded":
			task.outputDirectory = request.OutputDirectory
			download, cancel := ctx, func() {}
			if !deadline.IsZero() {
				download, cancel = context.WithDeadline(ctx, deadline)
			}
			file, err := p.download(download, task, result, provider)
			cancel()
			if err != nil {
				return p.providerTaskError(ctx, task, err)
			}
			if err := p.complete(ctx, task, file, request.SourceGroup); err != nil {
				return err
			}
			if *onCompleted != nil && task.Type == "video" {
				(*onCompleted)()
			}
			return nil
		default:
			return p.transition(ctx, task, "failed", task.ProviderTaskID, "上游返回了未知任务状态")
		}
	}
	return fmt.Errorf("unknown generation state %q", task.Status)
}

func (p *project) providerTaskError(ctx context.Context, task Task, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	next := "polling"
	var providerError interface{ Permanent() bool }
	if errors.As(err, &providerError) && providerError.Permanent() {
		next = "failed"
	}
	return p.transition(ctx, task, next, task.ProviderTaskID, (videoHTTP{}).safeMessage(err.Error()))
}

func (p *project) transition(ctx context.Context, task Task, status, providerID, message string) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := updateTask(ctx, tx, task, status, providerID, "", "", message); err != nil {
		return err
	}
	if status != task.Status || message != task.Error {
		if _, err := addEvent(ctx, tx, "task", []string{task.ID}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if status != task.Status || message != task.Error {
		p.notify()
	}
	return nil
}

func updateTask(ctx context.Context, tx *sql.Tx, task Task, status, providerID, nodeID, output, message string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	completed := ""
	switch status {
	case "succeeded", "failed", "cancelled", "uncertain":
		completed = now
	}
	updated, err := tx.ExecContext(ctx, `UPDATE tasks SET status=?,provider_id=?,result_node_id=?,error=?,updated_at=?,completed_at=?,output_path=?
  WHERE id=? AND status=?`, status, providerID, nodeID, message, now, completed, output, task.ID, task.Status)
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("task %s no longer has state %s", task.ID, task.Status)
	}
	return nil
}

func (p *project) download(ctx context.Context, task Task, result ProviderResult, provider Provider) (string, error) {
	extension := strings.ToLower(result.Extension)
	valid := task.Type == "image" && slices.Contains([]string{".png", ".jpg", ".jpeg", ".webp"}, extension) ||
		task.Type == "video" && slices.Contains([]string{".mp4", ".webm", ".mov"}, extension)
	if !valid {
		return "", fmt.Errorf("provider returned unsupported %s file extension %q", task.Type, result.Extension)
	}
	root, err := os.OpenRoot(p.dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	directory := path.Join("assets", task.Type+"s")
	if task.Type == "video" && task.outputDirectory != "" {
		directory = task.outputDirectory
	}
	if task.Type == "video" {
		if err := validateOutputDirectory(directory); err != nil {
			return "", permanentProviderError(err.Error())
		}
	}
	if err := root.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	dest := path.Join(directory, task.ID+extension)
	tmp := dest + ".part"
	if err := root.Remove(tmp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	file, err := root.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer root.Remove(tmp)
	call, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := provider.Download(call, result, file); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("provider download failed: %w", err)
	}
	info, statErr := file.Stat()
	if statErr == nil && task.Type == "video" {
		probe := make([]byte, 512)
		n, err := file.ReadAt(probe, 0)
		if err != nil && !errors.Is(err, io.EOF) {
			statErr = err
		} else if !isVideoOutput(probe[:n]) {
			statErr = permanentProviderError("下载结果不是可识别的视频文件")
		}
	}
	if err := errors.Join(statErr, file.Sync(), file.Close()); err != nil {
		return "", err
	}
	if info.Size() == 0 {
		return "", fmt.Errorf("provider downloaded an empty file")
	}
	if err := root.Rename(tmp, dest); err != nil {
		return "", err
	}
	return dest, nil
}

func (p *project) complete(ctx context.Context, task Task, file string, group *sourceGroup) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if group == nil {
		stored, err := readSourceGroup(ctx, tx, task.NodeID)
		if err != nil {
			return err
		}
		group = &stored
	}
	node := NodeInput{Type: task.Type, BasedOn: task.NodeID,
		EpisodeID: group.EpisodeID, SceneID: group.SceneID, ShotID: group.ShotID}
	node.Content, err = json.Marshal(map[string]string{"path": file, "providerTaskId": task.ProviderTaskID})
	if err != nil {
		return err
	}
	result, err := appendNodes(ctx, tx, task.CreatedBySession, []NodeInput{node}, nil, false)
	if err != nil {
		return err
	}
	if err := updateTask(ctx, tx, task, "succeeded", task.ProviderTaskID, result.IDs[0], file, ""); err != nil {
		return err
	}
	if _, err := addEvent(ctx, tx, "task", []string{task.ID}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	p.notify()
	return nil
}
