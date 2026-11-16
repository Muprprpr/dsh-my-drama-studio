package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type workflowSnapshot struct {
	workflowFileVersions
	WorkflowProfileID         string `json:"workflowProfileId,omitempty"`
	WorkflowDefinitionVersion int64  `json:"workflowDefinitionVersion,omitempty"`
	StageID                   string `json:"stageId"`
	SkillID                   string `json:"skillId,omitempty"`
	SkillPath                 string `json:"skillPath"`
	HarnessPath               string `json:"harnessPath"`
	SkillSourceSHA256         string `json:"skillSourceSha256"`
	SkillBody                 string `json:"skillBody"`
	HarnessBody               string `json:"harnessBody"`
}

var workflowLegacyActivation = &requestError{http.StatusConflict, "当前阶段没有可恢复的能力快照，请退出后重新激活。"}

func workflowDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func persistWorkflowSnapshot(ctx context.Context, tx *sql.Tx, profile *workflowProfile, stageID string, snapshot *workflowSnapshot) (string, error) {
	if stageID == "" {
		if snapshot != nil {
			return "", invalid("普通聊天不能指定阶段能力快照")
		}
		return "", nil
	}
	index := profile.stageIndex(stageID)
	if index < 0 || snapshot == nil || snapshot.StageID != stageID {
		return "", invalid("激活或交接需要当前目标阶段的能力快照")
	}
	stage := profile.stage(index)
	if !snapshot.matchesProfile(profile) {
		return "", invalid("阶段能力快照的生产模式、版本或 Skill ID 无效")
	}
	if snapshot.HarnessPath != "drama-studio/workflows/"+dramaWorkflowID+"/"+stage.Harness ||
		!snapshot.workflowFileVersions.valid() || !validWorkflowSHA256(snapshot.SkillSourceSHA256) ||
		strings.TrimSpace(snapshot.SkillBody) == "" || strings.TrimSpace(snapshot.HarnessBody) == "" ||
		len(snapshot.SkillBody) > 520<<10 || len(snapshot.HarnessBody) > 64<<10 ||
		snapshot.SkillSHA256 != workflowDigest([]byte(snapshot.SkillBody)) ||
		snapshot.HarnessSHA256 != workflowDigest([]byte(snapshot.HarnessBody)) {
		return "", invalid("阶段能力快照路径、正文或 SHA-256 无效")
	}
	record, err := json.Marshal(snapshot)
	if err != nil {
		return "", err
	}
	id := workflowDigest(record)
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_capability_snapshots(id,record) VALUES(?,?) ON CONFLICT(id) DO NOTHING`, id, string(record))
	return id, err
}

func (s workflowSnapshot) matchesProfile(profile *workflowProfile) bool {
	return profile != nil && s.WorkflowProfileID == profile.ID && s.WorkflowDefinitionVersion == profile.Version &&
		workflowIdentifier.MatchString(s.SkillID) && s.SkillPath == "skills/"+s.SkillID+"/SKILL.md"
}

func (p *project) workflowSession(ctx context.Context, sessionID string, stateOnly bool) (workflowSessionResult, error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return workflowSessionResult{}, err
	}
	defer tx.Rollback()
	profile, err := readWorkflowProfile(ctx, tx)
	if err != nil {
		return workflowSessionResult{}, err
	}
	session, err := readWorkflowSession(ctx, tx, sessionID)
	result := sessionResult(profile, session)
	if err != nil || stateOnly || session.SnapshotID == "" {
		return result, err
	}
	result.Snapshot, err = readWorkflowSnapshot(ctx, tx, profile, session)
	return result, err
}

func readWorkflowSnapshot(ctx context.Context, query rowQuery, profile *workflowProfile, session workflowSession) (*workflowSnapshot, error) {
	var record string
	err := query.QueryRowContext(ctx, `SELECT record FROM workflow_capability_snapshots WHERE id=?`, session.SnapshotID).Scan(&record)
	if errors.Is(err, sql.ErrNoRows) || err == nil && workflowDigest([]byte(record)) != session.SnapshotID {
		return nil, &requestError{http.StatusConflict, "当前阶段能力快照不可用，请退出后重新激活。"}
	}
	if err != nil {
		return nil, err
	}
	var snapshot workflowSnapshot
	if err := json.Unmarshal([]byte(record), &snapshot); err != nil {
		return nil, &requestError{http.StatusConflict, "当前阶段能力快照不可读取，请退出后重新激活。"}
	}
	if profile == legacyWorkflowProfile && snapshot.WorkflowProfileID == "" && snapshot.WorkflowDefinitionVersion == 0 && snapshot.SkillID == "" {
		// Keep the stored record and its hash intact. Supply the fields old readers inferred from the path.
		snapshot.WorkflowProfileID, snapshot.WorkflowDefinitionVersion = profile.ID, profile.Version
		snapshot.SkillID = strings.TrimSuffix(strings.TrimPrefix(snapshot.SkillPath, "skills/"), "/SKILL.md")
	}
	if !snapshot.matchesProfile(profile) || snapshot.StageID != session.ActiveStageID ||
		profile.stageIndex(snapshot.StageID) < 0 || snapshot.workflowFileVersions != session.workflowFileVersions {
		return nil, &requestError{http.StatusConflict, "当前阶段能力快照与激活信息不一致，请退出后重新激活。"}
	}
	return &snapshot, nil
}

func advanceWorkflowActivation(ctx context.Context, tx *sql.Tx, profile *workflowProfile, sessionID, stageID, handoffID string, snapshot *workflowSnapshot) error {
	snapshotID, err := persistWorkflowSnapshot(ctx, tx, profile, stageID, snapshot)
	if err != nil {
		return err
	}
	var versions workflowFileVersions
	var at string
	if snapshot != nil {
		versions, at = snapshot.workflowFileVersions, workflowNow()
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_sessions(session_id,stage_id,activation,skill_sha,harness_sha,
		pending_handoff,snapshot_id,activated_at,transition_pending)
		VALUES(?,?,1,?,?,?,NULLIF(?,''),?,1) ON CONFLICT(session_id) DO UPDATE SET stage_id=excluded.stage_id,
		activation=activation+1, skill_sha=excluded.skill_sha, harness_sha=excluded.harness_sha,
		pending_handoff=excluded.pending_handoff, snapshot_id=excluded.snapshot_id, activated_at=excluded.activated_at,
		transition_pending=1,error=''`,
		sessionID, stageID, versions.SkillSHA256, versions.HarnessSHA256, handoffID, snapshotID, at)
	return err
}

type workflowTransitionArgs struct {
	operation
	Activation int64 `json:"activation"`
}

func (p *project) completeWorkflowTransition(ctx context.Context, r Request, args workflowTransitionArgs) (any, error) {
	if args.Activation <= 0 {
		return nil, invalid("需要有效的阶段激活序号")
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		result, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET transition_pending=0
			WHERE session_id=? AND activation=? AND transition_pending=1 AND (stage_id='' OR snapshot_id IS NOT NULL)`,
			r.SessionID, args.Activation)
		if err != nil {
			return nil, err
		}
		if count, err := result.RowsAffected(); err != nil {
			return nil, err
		} else if count != 0 {
			if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
				return nil, err
			}
		}
		return readWorkflowSessionResult(ctx, tx, r.SessionID)
	})
}
