package studio

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"dsh-my-drama-studio/resources"
)

const legacyWorkflowProfileID = "legacy-drama-production"

type workflowProfile struct {
	ID      string                    `json:"id"`
	Name    string                    `json:"name"`
	Version int64                     `json:"version"`
	Stages  []workflowStageDefinition `json:"stages"`
}

type workflowStageDefinition struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	DefaultSkill string   `json:"defaultSkill"`
	Requires     []string `json:"requires"`
}

var workflowIdentifier = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var workflowProfiles = loadWorkflowProfiles()
var legacyWorkflowProfile = workflowProfiles[legacyWorkflowProfileID]
var workflowProfileRequired = &requestError{http.StatusConflict, "请先选择当前 Workspace 的生产模式"}

func loadWorkflowProfiles() map[string]*workflowProfile {
	const directory = "workflow-profiles"
	files, err := resources.WorkflowProfiles.ReadDir(directory)
	if err != nil {
		panic(err)
	}
	profiles := make(map[string]*workflowProfile, len(files))
	for _, file := range files {
		raw, err := resources.WorkflowProfiles.ReadFile(directory + "/" + file.Name())
		if err != nil {
			panic(err)
		}
		profile, err := decodeWorkflowProfile(file.Name(), raw)
		if err != nil {
			panic(fmt.Errorf("invalid workflow profile %s: %w", file.Name(), err))
		}
		profiles[profile.ID] = profile
	}
	return profiles
}

func decodeWorkflowProfile(filename string, raw []byte) (*workflowProfile, error) {
	var profile workflowProfile
	if err := decodeData(raw, &profile); err != nil {
		return nil, err
	}
	if !workflowIdentifier.MatchString(profile.ID) || filename != profile.ID+".json" ||
		strings.TrimSpace(profile.Name) == "" || profile.Version <= 0 || len(profile.Stages) == 0 {
		return nil, errors.New("profile id, filename, name, version and stages must be valid")
	}
	seen := make(map[string]bool, len(profile.Stages))
	for _, stage := range profile.Stages {
		if seen[stage.ID] || !workflowIdentifier.MatchString(stage.ID) || !workflowIdentifier.MatchString(stage.DefaultSkill) ||
			strings.TrimSpace(stage.Name) == "" || stage.Requires == nil {
			return nil, fmt.Errorf("invalid stage definition %q", stage.ID)
		}
		dependencies := make(map[string]bool, len(stage.Requires))
		for _, required := range stage.Requires {
			if !seen[required] || dependencies[required] {
				return nil, fmt.Errorf("stage %q requires an earlier stage exactly once: %q", stage.ID, required)
			}
			dependencies[required] = true
		}
		seen[stage.ID] = true
	}
	return &profile, nil
}

func (p *workflowProfile) stageIndex(id string) int {
	if p == nil {
		return -1
	}
	return slices.IndexFunc(p.Stages, func(stage workflowStageDefinition) bool { return stage.ID == id })
}

func (p *workflowProfile) stage(index int) workflowStage {
	stage := p.Stages[index]
	return workflowStage{
		ID: stage.ID, Name: stage.Name, Skill: stage.DefaultSkill, Requires: stage.Requires,
		Harness: "stages/" + stage.ID + "/harness.md",
	}
}

func (p *workflowProfile) nextStage(index int) string {
	if index+1 >= len(p.Stages) {
		return ""
	}
	return p.Stages[index+1].ID
}

func readWorkflowProfile(ctx context.Context, query rowQuery) (*workflowProfile, error) {
	var id string
	var version int64
	err := query.QueryRowContext(ctx, "SELECT profile_id, definition_version FROM workflow_profile WHERE singleton=1").Scan(&id, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	profile := workflowProfiles[id]
	if profile == nil || profile.Version != version {
		return nil, &requestError{http.StatusConflict, fmt.Sprintf("当前 Studio 版本缺少生产模式 %s v%d", id, version)}
	}
	return profile, nil
}

func initWorkflowProfile(ctx context.Context, tx *sql.Tx, profile *workflowProfile) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO workflow_profile(singleton,profile_id,definition_version)
		VALUES(1,?,?) ON CONFLICT(singleton) DO NOTHING`, profile.ID, profile.Version)
	return err
}

type workflowProfileArgs struct {
	operation
	WorkflowProfileID string `json:"workflowProfileId"`
}

func (p *project) selectWorkflowProfile(ctx context.Context, r Request, args workflowProfileArgs) (any, error) {
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		profile, err := readWorkflowProfile(ctx, tx)
		if err != nil {
			return nil, err
		}
		if profile == nil {
			profile = workflowProfiles[args.WorkflowProfileID]
			if err := initWorkflowProfile(ctx, tx, profile); err != nil {
				return nil, err
			}
			if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
				return nil, err
			}
		} else if profile.ID != args.WorkflowProfileID {
			return nil, &requestError{http.StatusConflict, "当前 Workspace 的生产模式已经固定"}
		}
		return readWorkflowView(ctx, tx, p.dir, r.SessionID, profile)
	})
}
