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
	Type          string                `json:"type"`
	Prompt        string                `json:"prompt"`
	Mode          string                `json:"mode,omitempty"`
	Profile       ProviderProfile       `json:"profile,omitzero"`
	WorkspacePath string                `json:"-"`
	References    []GenerationReference `json:"references,omitempty"`
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
	Status    string // pending, running, succeeded, failed
	URL       string
	Extension string // e.g. .png, .mp4
}

func (s *Service) wakeWorker() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run is the single process worker. A nil provider never executes jobs.
func (s *Service) Run(ctx context.Context) {
	if s.provider == nil {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		s.mu.Lock()
		keys := make([]string, 0, len(s.projects))
		for key := range s.projects {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		projects := make([]*project, 0, len(keys))
		for _, key := range keys {
			projects = append(projects, s.projects[key])
		}
		s.mu.Unlock()
		for _, p := range projects {
			if err := p.advance(ctx, s.provider); err != nil && ctx.Err() == nil {
				log.Printf("Studio task worker: %v", err)
			}
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		case <-s.wake:
		}
	}
}

func (p *project) advance(ctx context.Context, registry providerRegistry) error {
	task, input, err := scanTask(p.db.QueryRowContext(ctx, "SELECT "+taskColumns+` FROM tasks
  WHERE status IN ('pending','submitting','polling')
  ORDER BY status <> 'submitting', updated_at, rowid LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var request GenerationInput
	var provider Provider
	if task.Status != "submitting" {
		if err := json.Unmarshal([]byte(input), &request); err != nil {
			return p.transition(ctx, task, "failed", task.ProviderTaskID, "Stored generation request is invalid")
		}
		request.WorkspacePath = p.dir
		provider, err = registry.Resolve(request.Profile)
		if err != nil {
			return p.transition(ctx, task, task.Status, task.ProviderTaskID, "Provider credential unavailable. Update provider settings to continue.")
		}
	}
	switch task.Status {
	case "pending":
		if err := p.transition(ctx, task, "submitting", "", ""); err != nil {
			return err
		}
		task.Status = "submitting"
		call, cancelCall := context.WithTimeout(ctx, 60*time.Second)
		reply, submitErr := provider.Submit(call, request)
		cancelCall()
		persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if strings.TrimSpace(reply.TaskID) != "" {
			return p.transition(persist, task, "polling", reply.TaskID, "")
		}
		message := "Submission outcome unknown. Confirm with provider before submitting again."
		if reply.Rejected {
			message = "Provider rejected submission."
		}
		if errors.Is(submitErr, context.DeadlineExceeded) {
			message += " The submission response timed out."
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
		call, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, err := provider.Poll(call, task.ProviderTaskID)
		cancel()
		if err != nil {
			return p.transition(ctx, task, "polling", task.ProviderTaskID, "Could not query provider status. Will retry polling.")
		}
		switch result.Status {
		case "pending", "running":
			return p.transition(ctx, task, "polling", task.ProviderTaskID, "")
		case "failed":
			return p.transition(ctx, task, "failed", task.ProviderTaskID, "Provider reported generation failure.")
		case "succeeded":
			file, err := p.download(ctx, task, result, provider)
			if err != nil {
				return p.transition(ctx, task, "polling", task.ProviderTaskID, err.Error())
			}
			return p.complete(ctx, task, file)
		default:
			return p.transition(ctx, task, "polling", task.ProviderTaskID, "Provider returned an unknown poll status")
		}
	}
	return fmt.Errorf("unknown generation state %q", task.Status)
}

func (p *project) transition(ctx context.Context, task Task, status, providerID, message string) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := updateTask(ctx, tx, task, status, providerID, "", message); err != nil {
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

func updateTask(ctx context.Context, tx *sql.Tx, task Task, status, providerID, nodeID, message string) error {
	updated, err := tx.ExecContext(ctx, `UPDATE tasks SET status=?,provider_id=?,result_node_id=?,error=?,updated_at=?
  WHERE id=? AND status=?`, status, providerID, nodeID, message, time.Now().UTC().Format(time.RFC3339Nano), task.ID, task.Status)
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
	if err := root.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	dest := path.Join(directory, task.ID+extension)
	tmp := dest + ".part"
	if err := root.Remove(tmp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	file, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer root.Remove(tmp)
	call, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := provider.Download(call, result, file); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("provider download failed")
	}
	info, statErr := file.Stat()
	if err := errors.Join(statErr, file.Close()); err != nil {
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

func (p *project) complete(ctx context.Context, task Task, file string) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	node := NodeInput{Type: task.Type, BasedOn: task.NodeID}
	if err := tx.QueryRowContext(ctx, "SELECT episode_id,scene_id,shot_id FROM nodes WHERE id=?", task.NodeID).
		Scan(&node.EpisodeID, &node.SceneID, &node.ShotID); err != nil {
		return err
	}
	node.Content, err = json.Marshal(map[string]string{"path": file, "providerTaskId": task.ProviderTaskID})
	if err != nil {
		return err
	}
	result, err := appendNodes(ctx, tx, task.CreatedBySession, []NodeInput{node}, nil)
	if err != nil {
		return err
	}
	if err := updateTask(ctx, tx, task, "succeeded", task.ProviderTaskID, result.IDs[0], ""); err != nil {
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
