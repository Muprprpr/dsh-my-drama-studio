package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type workflowHandoff struct {
	workflowFileVersions
	HandoffID                 string                   `json:"handoffId"`
	SourceStageID             string                   `json:"sourceStageId"`
	TargetStageID             string                   `json:"targetStageId,omitempty"`
	WorkspaceID               string                   `json:"workspaceId"`
	SourceSessionID           string                   `json:"sourceSessionId"`
	WorkflowProfileID         string                   `json:"workflowProfileId,omitempty"`
	WorkflowDefinitionVersion int64                    `json:"workflowDefinitionVersion,omitempty"`
	SourceRevision            int64                    `json:"sourceRevision,omitempty"`
	PreviewBaseline           *workflowPreviewBaseline `json:"previewBaseline,omitempty"`
	ReuseReviews              []workflowReuseReview    `json:"reuseReviews,omitempty"`
	Artifacts                 []workflowArtifact       `json:"artifacts"`
	Summary                   string                   `json:"summary"`
	ConfirmedDecisions        []string                 `json:"confirmedDecisions"`
	Constraints               []string                 `json:"constraints"`
	CreatedAt                 string                   `json:"createdAt"`
	ConfirmedAt               string                   `json:"confirmedAt,omitempty"`
	Stale                     bool                     `json:"stale,omitempty"`
}

type workflowPreviewBaseline struct {
	PriorHandoffID string           `json:"priorHandoffId,omitempty"`
	InputKey       string           `json:"inputKey,omitempty"`
	ArtifactHeads  map[string]int64 `json:"artifactHeads"`
}

type workflowReuseReview struct {
	workflowArtifactRef
	ReusedFrom             workflowArtifactRef  `json:"reusedFrom"`
	PreviousInputs         []workflowReuseInput `json:"previousInputs"`
	CurrentInputs          []workflowReuseInput `json:"currentInputs"`
	PreviousProductionSpec *productionSpec      `json:"previousProductionSpec,omitempty"`
	CurrentProductionSpec  *productionSpec      `json:"currentProductionSpec,omitempty"`
}

type workflowReuseInput struct {
	HandoffID      string `json:"handoffId"`
	SourceStageID  string `json:"sourceStageId"`
	SourceRevision int64  `json:"sourceRevision"`
}

type workflowPreviewArgs struct {
	operation
	StageID   string                `json:"stageId,omitempty"`
	Artifacts []workflowArtifactRef `json:"artifacts,omitempty"`
}

type workflowConfirmArgs struct {
	operation
	HandoffID string            `json:"handoffId"`
	Snapshot  *workflowSnapshot `json:"snapshot,omitempty"`
}

type workflowHandoffTarget struct {
	TargetStage *workflowStage `json:"targetStage,omitempty"`
}

type workflowHandoffConfirmation struct {
	Handoff   workflowHandoff `json:"handoff"`
	Committed bool            `json:"committed"`
}

var (
	workflowHandoffContentChanged    = &requestError{http.StatusConflict, "交接内容已发生变化，请重新生成交接预览后确认。"}
	workflowHandoffActivationChanged = &requestError{http.StatusConflict, "当前阶段已经发生变化，请重新检查当前工作流状态。"}
	workflowHandoffPeerConfirmed     = &requestError{http.StatusConflict, "该阶段已经由其他 Session 完成交接，请刷新工作流进度。"}
	workflowHandoffPermission        = &requestError{http.StatusConflict, "当前 Session 已不具备该阶段的交接权限。"}
	workflowHandoffDefinitionChanged = &requestError{http.StatusConflict, "当前工作流定义已更新，请重新检查阶段关系。"}
)

func (p *project) workflowHandoffTarget(ctx context.Context, r Request, handoffID string) (workflowHandoffTarget, error) {
	var out workflowHandoffTarget
	if handoffID == "" {
		return out, invalid("请先生成交接预览")
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	handoff, activation, confirmed, err := readOwnedWorkflowHandoff(ctx, tx, r, handoffID)
	if err != nil || confirmed {
		// Confirmation can replay its stored result without reading today's files.
		return out, err
	}
	profile, index, err := verifyHandoffStage(ctx, tx, r, handoff, activation)
	if err != nil {
		return out, err
	}
	if handoff.TargetStageID != "" {
		stage := profile.stage(index + 1)
		out.TargetStage = &stage
	}
	return out, nil
}

func readOwnedWorkflowHandoff(ctx context.Context, tx *sql.Tx, r Request, handoffID string) (workflowHandoff, int64, bool, error) {
	var handoff workflowHandoff
	var activation int64
	var confirmed, stale bool
	var record string
	err := tx.QueryRowContext(ctx, `SELECT record,activation,revision IS NOT NULL,stale FROM workflow_handoffs WHERE id=? AND session_id=?`,
		handoffID, r.SessionID).Scan(&record, &activation, &confirmed, &stale)
	if errors.Is(err, sql.ErrNoRows) {
		err = workflowHandoffPermission
	}
	if err != nil {
		return handoff, 0, false, err
	}
	if err := json.Unmarshal([]byte(record), &handoff); err != nil {
		return handoff, 0, false, err
	}
	if handoff.WorkspaceID != r.WorkspaceID || handoff.SourceSessionID != r.SessionID {
		return handoff, 0, false, workflowHandoffPermission
	}
	handoff.Stale = stale
	return handoff, activation, confirmed, nil
}

func verifyHandoffStage(ctx context.Context, tx *sql.Tx, r Request, handoff workflowHandoff, activation int64) (*workflowProfile, int, error) {
	if handoff.PreviewBaseline == nil {
		return nil, 0, workflowHandoffContentChanged
	}
	profile, err := readWorkflowProfile(ctx, tx)
	var known *requestError
	if errors.As(err, &known) && known.code == http.StatusConflict {
		return nil, 0, workflowHandoffDefinitionChanged
	}
	if err != nil {
		return nil, 0, err
	}
	index := profile.stageIndex(handoff.SourceStageID)
	if index < 0 || handoff.WorkflowProfileID != profile.ID || handoff.WorkflowDefinitionVersion != profile.Version ||
		handoff.TargetStageID != profile.nextStage(index) {
		return nil, 0, workflowHandoffDefinitionChanged
	}
	session, err := readWorkflowSession(ctx, tx, r.SessionID)
	if err != nil {
		return nil, 0, err
	}
	if session.Activation != activation || session.ActiveStageID != handoff.SourceStageID ||
		session.workflowFileVersions != handoff.workflowFileVersions {
		return nil, 0, workflowHandoffActivationChanged
	}
	if session.SnapshotID == "" {
		return nil, 0, workflowHandoffPermission
	}
	if session.RunID != "" {
		return nil, 0, workflowTurnRunning
	}
	if _, err := readWorkflowSnapshot(ctx, tx, profile, session); err != nil {
		if errors.As(err, &known) && known.code == http.StatusConflict {
			return nil, 0, workflowHandoffPermission
		}
		return nil, 0, err
	}
	return profile, index, nil
}
func readWorkflowHandoffs(ctx context.Context, tx *sql.Tx) ([]workflowHandoff, error) {
	return queryConfirmedWorkflowHandoffs(ctx, tx, false)
}

func readLatestWorkflowHandoffs(ctx context.Context, tx *sql.Tx) (map[string]workflowHandoff, error) {
	history, err := queryConfirmedWorkflowHandoffs(ctx, tx, true)
	return latestWorkflowHandoffs(history), err
}

func queryConfirmedWorkflowHandoffs(ctx context.Context, tx *sql.Tx, latestOnly bool) ([]workflowHandoff, error) {
	query := `SELECT record,stale FROM workflow_handoffs h WHERE revision IS NOT NULL`
	if latestOnly {
		query += ` AND revision=(SELECT MAX(revision) FROM workflow_handoffs WHERE stage_id=h.stage_id)`
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY revision DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	handoffs := []workflowHandoff{}
	for rows.Next() {
		var body string
		var stale bool
		if err := rows.Scan(&body, &stale); err != nil {
			return nil, err
		}
		var item workflowHandoff
		if err := json.Unmarshal([]byte(body), &item); err != nil {
			return nil, err
		}
		item.Stale = stale
		handoffs = append(handoffs, item)
	}
	return handoffs, rows.Err()
}

func latestWorkflowHandoffs(history []workflowHandoff) map[string]workflowHandoff {
	latest := make(map[string]workflowHandoff)
	for _, handoff := range history {
		if _, exists := latest[handoff.SourceStageID]; !exists {
			latest[handoff.SourceStageID] = handoff
		}
	}
	return latest
}

func (p *workflowProfile) inputs(latest map[string]workflowHandoff, index int) []workflowHandoff {
	result := []workflowHandoff{}
	for _, stage := range p.Stages[:index] {
		if handoff, ok := latest[stage.ID]; ok && !handoff.Stale {
			result = append(result, handoff)
		}
	}
	return result
}

func hasWorkflowInput(inputs []workflowHandoff, id string) bool {
	return slices.ContainsFunc(inputs, func(input workflowHandoff) bool { return input.HandoffID == id })
}

func workflowSpecPrefix(spec productionSpec) string {
	seconds := int64(0)
	if spec.TargetDurationSeconds != nil {
		seconds = *spec.TargetDurationSeconds
	}
	return fmt.Sprintf("@%s/%d|", spec.AspectRatio, seconds)
}

func workflowInputKey(inputs []workflowHandoff, spec productionSpec) string {
	var ids strings.Builder
	ids.WriteString(workflowSpecPrefix(spec))
	for _, input := range inputs {
		fmt.Fprintf(&ids, "%d:%s", len(input.HandoffID), input.HandoffID)
	}
	return ids.String()
}

func workflowLegacyInputKey(key string) string {
	// A legacy key did not record any project specification.
	return strings.TrimPrefix(key, workflowSpecPrefix(productionSpec{}))
}

func workflowInputKeysEqual(a, b string) bool {
	return workflowLegacyInputKey(a) == workflowLegacyInputKey(b)
}

func splitWorkflowInputKey(key string) (productionSpec, string, error) {
	var spec productionSpec
	if !strings.HasPrefix(key, "@") {
		return spec, key, nil
	}
	prefix, tail, separated := strings.Cut(key[1:], "|")
	ratio, duration, hasDuration := strings.Cut(prefix, "/")
	seconds, err := strconv.ParseInt(duration, 10, 64)
	spec.AspectRatio = ratio
	if seconds != 0 {
		spec.TargetDurationSeconds = &seconds
	}
	if !separated || !hasDuration || err != nil || !spec.valid() {
		return productionSpec{}, "", errors.New("invalid workflow production spec")
	}
	return spec, tail, nil
}

func productionSpecFromInputKey(key string) (productionSpec, error) {
	spec, _, err := splitWorkflowInputKey(key)
	return spec, err
}

func workflowInputIDs(key string) ([]string, error) {
	_, key, err := splitWorkflowInputKey(key)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for key != "" {
		length, tail, ok := strings.Cut(key, ":")
		size, err := strconv.Atoi(length)
		if !ok || err != nil || size <= 0 || size > len(tail) {
			return nil, errors.New("invalid workflow input key")
		}
		ids = append(ids, tail[:size])
		key = tail[size:]
	}
	return ids, nil
}

func (p *workflowProfile) requireWorkflowInputs(latest map[string]workflowHandoff, index int) error {
	for _, id := range p.Stages[index].Requires {
		stage := p.Stages[p.stageIndex(id)]
		handoff, exists := latest[id]
		if handoff.Stale {
			return &requestError{http.StatusConflict, fmt.Sprintf("上游阶段「%s」的正式交接已过期，请先更新", stage.Name)}
		}
		if !exists {
			return &requestError{http.StatusConflict, fmt.Sprintf("请先确认上游阶段「%s」的正式交接", stage.Name)}
		}
	}
	return nil
}

func workflowRevision(ctx context.Context, tx *sql.Tx) (int64, error) {
	var revision int64
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(revision),0) FROM workflow_handoffs`).Scan(&revision)
	return revision, err
}

func workflowArtifactHead(ctx context.Context, tx *sql.Tx, artifact workflowArtifact) (int64, error) {
	var head int64
	var hasVersion bool
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version),0), COUNT(CASE WHEN version=? THEN 1 END)>0
		FROM workflow_artifacts WHERE id=? AND session_id=? AND stage_id=?`,
		artifact.Version, artifact.ArtifactID, artifact.SessionID, artifact.StageID).Scan(&head, &hasVersion)
	if err == nil && !hasVersion {
		err = workflowHandoffContentChanged
	}
	return head, err
}

func (p *project) previewWorkflowHandoff(ctx context.Context, r Request, args workflowPreviewArgs) (any, error) {
	if len(args.Artifacts) > maxWorkflowOutputs {
		return nil, invalid("交接最多包含 %d 项产物", maxWorkflowOutputs)
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, status Status) (any, error) {
		profile, err := readWorkflowProfile(ctx, tx)
		if err != nil {
			return nil, err
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		index := profile.stageIndex(session.ActiveStageID)
		if index < 0 || session.RunID != "" || args.StageID != "" && args.StageID != session.ActiveStageID {
			return nil, &requestError{http.StatusConflict, "请在当前阶段回合结束后生成交接预览"}
		}
		if session.SnapshotID == "" {
			return nil, workflowHandoffPermission
		}
		latest, err := readLatestWorkflowHandoffs(ctx, tx)
		if err != nil {
			return nil, err
		}
		if err := profile.requireWorkflowInputs(latest, index); err != nil {
			return nil, err
		}
		inputs := profile.inputs(latest, index)
		spec, err := readProductionSpec(ctx, tx)
		if err != nil {
			return nil, err
		}
		inputKey := workflowInputKey(inputs, spec)
		artifacts, err := selectWorkflowArtifacts(ctx, tx, r.SessionID, session.ActiveStageID, inputKey, args.Artifacts)
		if err != nil {
			return nil, err
		}
		selected := artifacts
		baseline := workflowPreviewBaseline{
			PriorHandoffID: latest[session.ActiveStageID].HandoffID,
			InputKey:       inputKey,
			ArtifactHeads:  make(map[string]int64, len(artifacts)),
		}
		// Record the contemporaneous head separately from the version deliberately selected by the user.
		// Auto-attached generated/inherited media are checked against live Canvas references instead.
		for _, artifact := range artifacts {
			head, err := workflowArtifactHead(ctx, tx, artifact)
			if err != nil {
				return nil, err
			}
			baseline.ArtifactHeads[artifact.ArtifactID] = head
		}
		if session.ActiveStageID == workflowGeneration {
			artifacts, err = p.addWorkflowVideoResults(ctx, tx, latest, r.SessionID, session, inputKey, artifacts)
			if err != nil {
				return nil, err
			}
		}
		if len(artifacts) == 0 || len(artifacts) > maxWorkflowOutputs {
			return nil, invalid("交接需要 1–%d 项有效阶段产物", maxWorkflowOutputs)
		}
		for _, artifact := range artifacts {
			if !workflowInputKeysEqual(artifact.inputKey, inputKey) {
				return nil, &requestError{http.StatusConflict, "草稿的制作规格或上游交接已更新，请重核后保存新版本"}
			}
		}
		if session.ActiveStageID == workflowFinalReview && !slices.ContainsFunc(artifacts, isWorkflowVideo) {
			for _, artifact := range latest[workflowGeneration].Artifacts {
				if isWorkflowVideo(artifact) {
					artifacts = append(artifacts, artifact)
				}
			}
			if len(artifacts) > maxWorkflowOutputs {
				return nil, invalid("交接最多包含 %d 项产物，请缩小产物选择", maxWorkflowOutputs)
			}
		}
		if err := p.checkWorkflowHandoffArtifacts(ctx, tx, latest, session.ActiveStageID, artifacts); err != nil {
			return nil, err
		}
		if previous, ok := latest[session.ActiveStageID]; ok && !previous.Stale && sameWorkflowArtifacts(previous.Artifacts, artifacts) {
			return nil, &requestError{http.StatusConflict, "这些版本已正式交接，请选择更新的产物"}
		}
		reuse, err := readWorkflowReuseReviews(ctx, tx, selected, inputs, spec)
		if err != nil {
			return nil, err
		}
		handoff := workflowHandoff{
			workflowFileVersions: session.workflowFileVersions,
			HandoffID:            uuid.NewString(), SourceStageID: session.ActiveStageID, TargetStageID: profile.nextStage(index),
			WorkspaceID: status.WorkspaceID, SourceSessionID: r.SessionID,
			WorkflowProfileID: profile.ID, WorkflowDefinitionVersion: profile.Version, PreviewBaseline: &baseline,
			Artifacts: artifacts, ReuseReviews: reuse, CreatedAt: workflowNow(), ConfirmedDecisions: []string{}, Constraints: []string{},
		}
		fillWorkflowHandoffSummary(&handoff)
		body, err := json.Marshal(handoff)
		if err != nil {
			return nil, err
		}
		// Older databases require a value in draft_watermark; the scoped proof is in record.
		_, err = tx.ExecContext(ctx, `INSERT INTO workflow_handoffs(id,stage_id,session_id,activation,draft_watermark,record)
			VALUES(?,?,?,?,0,?)`, handoff.HandoffID, handoff.SourceStageID, r.SessionID, session.Activation, string(body))
		return handoff, err
	})
}

func selectWorkflowArtifacts(ctx context.Context, tx *sql.Tx, sessionID, stageID, inputKey string, refs []workflowArtifactRef) ([]workflowArtifact, error) {
	if refs == nil {
		return readCurrentWorkflowDrafts(ctx, tx, sessionID, stageID, inputKey)
	}
	out := make([]workflowArtifact, 0, len(refs))
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		if ref.ArtifactID == "" || ref.Version < 1 || seen[ref.ArtifactID] {
			return nil, invalid("每项产物只能选择一个有效版本")
		}
		seen[ref.ArtifactID] = true
		item, err := scanWorkflowArtifact(tx.QueryRowContext(ctx, `SELECT record,input_key FROM workflow_artifacts
			WHERE session_id=? AND stage_id=? AND id=? AND version=?`, sessionID, stageID, ref.ArtifactID, ref.Version))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &requestError{http.StatusConflict, "只能交接当前 Session 当前阶段的产物"}
		}
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func readWorkflowReuseReviews(ctx context.Context, tx *sql.Tx, artifacts []workflowArtifact, inputs []workflowHandoff, spec productionSpec) ([]workflowReuseReview, error) {
	current := make([]workflowReuseInput, 0, len(inputs))
	for _, input := range inputs {
		current = append(current, workflowReuseInput{
			HandoffID: input.HandoffID, SourceStageID: input.SourceStageID, SourceRevision: input.SourceRevision,
		})
	}
	var reviews []workflowReuseReview
	for _, artifact := range artifacts {
		from := artifact.ReusedFrom
		if from == nil {
			continue
		}
		var oldKey string
		if err := tx.QueryRowContext(ctx, `SELECT input_key FROM workflow_artifacts WHERE id=? AND version=?`,
			from.ArtifactID, from.Version).Scan(&oldKey); err != nil {
			return nil, err
		}
		ids, err := workflowInputIDs(oldKey)
		if err != nil {
			return nil, err
		}
		review := workflowReuseReview{workflowArtifactRef: artifact.workflowArtifactRef, ReusedFrom: *from,
			PreviousInputs: make([]workflowReuseInput, 0, len(ids)), CurrentInputs: current}
		previous, err := productionSpecFromInputKey(oldKey)
		if err != nil {
			return nil, err
		}
		if workflowSpecPrefix(previous) != workflowSpecPrefix(spec) {
			review.PreviousProductionSpec, review.CurrentProductionSpec = &previous, &spec
		}
		for _, id := range ids {
			input := workflowReuseInput{HandoffID: id}
			if err := tx.QueryRowContext(ctx, `SELECT stage_id,revision
				FROM workflow_handoffs WHERE id=? AND revision IS NOT NULL`, id).
				Scan(&input.SourceStageID, &input.SourceRevision); err != nil {
				return nil, err
			}
			review.PreviousInputs = append(review.PreviousInputs, input)
		}
		reviews = append(reviews, review)
	}
	return reviews, nil
}

func sameWorkflowArtifacts(left, right []workflowArtifact) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[workflowArtifactRef]bool, len(left))
	for _, artifact := range left {
		seen[artifact.workflowArtifactRef] = true
	}
	for _, artifact := range right {
		if !seen[artifact.workflowArtifactRef] {
			return false
		}
	}
	return true
}

func fillWorkflowHandoffSummary(handoff *workflowHandoff) {
	lines := make([]string, 0, len(handoff.Artifacts))
	for _, item := range handoff.Artifacts {
		summary := strings.TrimSpace(item.Summary)
		if summary == "" && item.Content != "" {
			excerpt := []rune(strings.Join(strings.Fields(item.Content), " "))
			if len(excerpt) > 140 {
				excerpt = append(excerpt[:140], '…')
			}
			summary = string(excerpt)
		}
		label := fmt.Sprintf("%s (V%d)", item.Title, item.Version)
		if summary != "" {
			label += " · " + summary
		}
		lines = append(lines, label)
		handoff.ConfirmedDecisions = appendUniqueNotes(handoff.ConfirmedDecisions, item.ConfirmedDecisions)
		handoff.Constraints = appendUniqueNotes(handoff.Constraints, item.Constraints)
	}
	handoff.Summary = strings.Join(lines, "\n")
}

func appendUniqueNotes(existing, newNotes []string) []string {
	for _, text := range newNotes {
		if text = strings.TrimSpace(text); text != "" && !slices.Contains(existing, text) {
			existing = append(existing, text)
		}
	}
	return existing
}

func (p *project) checkWorkflowHandoffArtifacts(ctx context.Context, tx *sql.Tx, latest map[string]workflowHandoff, stageID string, artifacts []workflowArtifact) error {
	refs := workflowMediaRefs(artifacts)
	if err := checkWorkflowRefs(ctx, tx, refs); err != nil {
		return err
	}
	switch stageID {
	case workflowDeployment:
		_, err := deploymentDrafts(ctx, tx, refs)
		return err
	case workflowGeneration:
		progress, results, err := workflowGenerationProgress(ctx, tx, p.dir, latest)
		if err != nil {
			return err
		}
		if progress.State != "ready" || len(results) != len(refs) {
			return generationResultChanged
		}
		for _, artifact := range results {
			if !slices.Contains(refs, artifact) {
				return generationResultChanged
			}
		}
	case workflowFinalReview:
		return checkFinalWorkflowVideos(ctx, tx, p.dir, latest[workflowGeneration], artifacts)
	}
	return nil
}

func isWorkflowVideo(artifact workflowArtifact) bool {
	return artifact.Kind == "video" && artifact.Node != nil
}

func (p *project) addWorkflowVideoResults(ctx context.Context, tx *sql.Tx, latest map[string]workflowHandoff, sessionID string,
	session workflowSession, inputKey string, artifacts []workflowArtifact) ([]workflowArtifact, error) {
	progress, refs, err := workflowGenerationProgress(ctx, tx, p.dir, latest)
	if err != nil {
		return nil, err
	}
	if progress.State != "ready" {
		return nil, &requestError{http.StatusConflict, progress.Message}
	}
	selected := workflowMediaRefs(artifacts)
	for _, ref := range selected {
		if !slices.Contains(refs, ref) {
			return nil, generationResultChanged
		}
	}
	for i, ref := range refs {
		if slices.Contains(selected, ref) {
			continue
		}
		node, err := readWorkflowNode(ctx, tx, ref.ID)
		if err != nil {
			return nil, err
		}
		item := workflowArtifact{
			workflowArtifactRef: workflowArtifactRef{
				ArtifactID: uuid.NewSHA1(uuid.NameSpaceURL, []byte(sessionID+"\x00"+ref.ID)).String(), Version: ref.Revision,
			},
			workflowFileVersions: session.workflowFileVersions,
			StageID:              workflowGeneration, SessionID: sessionID, Title: fmt.Sprintf("视频生成结果 %d", i+1),
			Kind: "video", NodeID: node.ID, Node: &node, CreatedAt: workflowNow(), inputKey: inputKey,
		}
		artifacts = append(artifacts, item)
	}
	return artifacts, nil
}

func (p *project) confirmWorkflowHandoff(ctx context.Context, r Request, args workflowConfirmArgs) (any, error) {
	if args.HandoffID == "" {
		return nil, invalid("请先生成交接预览")
	}
	committed := false
	result, err := p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		handoff, activation, confirmed, err := readOwnedWorkflowHandoff(ctx, tx, r, args.HandoffID)
		if err != nil {
			return nil, err
		}
		if confirmed {
			return handoff, nil
		}
		profile, index, err := verifyHandoffStage(ctx, tx, r, handoff, activation)
		if err != nil {
			return nil, err
		}
		latest, err := readLatestWorkflowHandoffs(ctx, tx)
		if err != nil {
			return nil, err
		}
		baseline := handoff.PreviewBaseline
		if prior := latest[handoff.SourceStageID]; prior.HandoffID != baseline.PriorHandoffID {
			if prior.HandoffID != "" && prior.SourceSessionID != r.SessionID {
				return nil, workflowHandoffPeerConfirmed
			}
			return nil, workflowHandoffContentChanged
		}
		spec, err := readProductionSpec(ctx, tx)
		if err != nil {
			return nil, err
		}
		if profile.requireWorkflowInputs(latest, index) != nil ||
			!workflowInputKeysEqual(workflowInputKey(profile.inputs(latest, index), spec), baseline.InputKey) {
			return nil, workflowHandoffContentChanged
		}
		for _, artifact := range handoff.Artifacts {
			if version, selected := baseline.ArtifactHeads[artifact.ArtifactID]; selected {
				head, err := workflowArtifactHead(ctx, tx, artifact)
				if err != nil {
					return nil, err
				}
				if head != version {
					return nil, workflowHandoffContentChanged
				}
			}
		}
		if err := p.checkWorkflowHandoffArtifacts(ctx, tx, latest, handoff.SourceStageID, handoff.Artifacts); err != nil {
			var known *requestError
			if errors.As(err, &known) && known.code == http.StatusConflict {
				return nil, workflowHandoffContentChanged
			}
			return nil, err
		}
		revision, err := workflowRevision(ctx, tx)
		if err != nil {
			return nil, err
		}
		if handoff.TargetStageID != "" {
			if err := advanceWorkflowActivation(ctx, tx, profile, r.SessionID, handoff.TargetStageID, handoff.HandoffID, args.Snapshot); err != nil {
				return nil, err
			}
		} else {
			if args.Snapshot != nil {
				return nil, invalid("最终验收没有下一阶段，不能指定目标能力快照")
			}
			// Final acceptance keeps the same activation and ends any pending kickoff.
			if _, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET pending_handoff='',error='' WHERE session_id=?`, r.SessionID); err != nil {
				return nil, err
			}
		}
		handoff.ConfirmedAt = workflowNow()
		handoff.SourceRevision = revision + 1
		for i := range handoff.Artifacts {
			handoff.Artifacts[i].HandedOff = true
		}
		body, err := json.Marshal(handoff)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_handoffs SET revision=?,record=? WHERE id=? AND revision IS NULL`,
			handoff.SourceRevision, string(body), handoff.HandoffID); err != nil {
			return nil, err
		}
		for _, downstream := range profile.Stages[index+1:] {
			if _, err := tx.ExecContext(ctx, `UPDATE workflow_handoffs SET stale=1 WHERE stage_id=? AND revision IS NOT NULL AND stale=0`,
				downstream.ID); err != nil {
				return nil, err
			}
		}
		if _, err := expireWorkflowKickoffs(ctx, tx, ""); err != nil {
			return nil, err
		}
		if _, err := addEvent(ctx, tx, "workflow", []string{handoff.SourceStageID}); err != nil {
			return nil, err
		}
		committed = true
		return handoff, nil
	})
	if err != nil {
		return nil, err
	}
	if handoff, ok := result.(workflowHandoff); ok {
		return workflowHandoffConfirmation{Handoff: handoff, Committed: committed}, nil
	}
	// A replayed operation stores only the durable Handoff receipt, never permission to dispatch again.
	var handoff workflowHandoff
	if err := json.Unmarshal(result.(json.RawMessage), &handoff); err != nil {
		return nil, err
	}
	if handoff.HandoffID != args.HandoffID || handoff.WorkspaceID != r.WorkspaceID {
		return nil, workflowHandoffPermission
	}
	return workflowHandoffConfirmation{Handoff: handoff}, nil
}
