package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"unicode/utf8"
)

func videoGenerationInput(ctx context.Context, tx *sql.Tx, workspace, id, snapshot string) (GenerationInput, string, []string, error) {
	var content struct {
		Prompt                string            `json:"prompt"`
		PromptDoc             json.RawMessage   `json:"promptDoc"`
		PromptDocLinked       bool              `json:"promptDocLinked"`
		Order                 []string          `json:"mixedListOrder"`
		TextList              []json.RawMessage `json:"textList"`
		Mode                  string            `json:"mode"`
		ProfileID             string            `json:"profileId"`
		Params                json.RawMessage   `json:"params"`
		ProductionAspectRatio string            `json:"productionAspectRatio"`
	}
	if err := json.Unmarshal([]byte(snapshot), &content); err != nil {
		return GenerationInput{}, "", nil, invalid("视频节点 %s 的提示词或输入格式无效：%s", id, err)
	}
	if len(content.TextList) != 0 {
		return GenerationInput{}, "", nil, invalid("视频节点 %s 的 textList 必须为空", id)
	}
	if err := validateVideoDraftFields(snapshot); err != nil {
		return GenerationInput{}, "", nil, err
	}
	params, err := decodeVideoParams(content.Params)
	if err != nil {
		return GenerationInput{}, "", nil, err
	}
	input := GenerationInput{Type: "video", Mode: content.Mode, Prompt: content.Prompt, Params: params,
		WorkspacePath: workspace, productionAspectRatio: content.ProductionAspectRatio}
	refs, err := videoEdgeReferences(ctx, tx, workspace, id, content.Order)
	if err != nil {
		return GenerationInput{}, "", nil, err
	}
	input.PromptMentions, err = resolveVideoMentions(id, content.Prompt, content.PromptDocLinked, content.PromptDoc, refs)
	if err != nil {
		return GenerationInput{}, "", nil, err
	}

	var kinds, sourceIDs []string
	for _, ref := range refs {
		input.References = append(input.References, ref.GenerationReference)
		kinds = append(kinds, ref.Type)
		sourceIDs = append(sourceIDs, ref.SourceNodeID)
		if ref.ResultNodeID != "" {
			sourceIDs = append(sourceIDs, ref.ResultNodeID)
		}
	}
	// Nodes created before mode selection was introduced infer their mode using
	// their connected images. Current drafts with mode:"" fail in submissionNode.
	if input.Mode == "" {
		for _, kind := range kinds {
			if kind != "image" {
				return GenerationInput{}, "", nil, invalid("引用视频或音频素材时请明确选择生成方式")
			}
		}
		switch len(refs) {
		case 0:
			input.Mode = "t2v"
		case 1:
			input.Mode = "i2v"
		default:
			input.Mode = "r2v"
		}
	}
	if err := validateVideoInputs(input.Mode, kinds); err != nil {
		return GenerationInput{}, "", nil, err
	}
	digests := make(map[string]string)
	for i := range input.References {
		ref := &input.References[i]
		if ref.Path != "" {
			digest := digests[ref.Path]
			if digest == "" {
				digest, err = freezeMediaFile(workspace, ref.Path)
				if err != nil {
					return GenerationInput{}, "", nil, invalid("视频节点 %s 的素材 %s：%s", id, ref.SourceNodeID, err)
				}
				digests[ref.Path] = digest
			}
			ref.LocalSHA256 = digest
		}
		switch input.Mode {
		case "i2v":
			ref.Role = "first_frame"
			if i == 1 {
				ref.Role = "last_frame"
			}
		case "v2v":
			ref.Role = "source_video"
		case "r2v":
			ref.Role = "reference_" + ref.Type
		}
	}
	return input, content.ProfileID, sourceIDs, nil
}

func freezeMediaFile(workspace, path string) (string, error) {
	file, err := openLocalReference(workspace, path, true)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return "", fmt.Errorf("项目文件 %q 已失效，请重新连接可用的素材", path)
	}
	digest, err := localMediaSHA256(file)
	if err != nil {
		return "", fmt.Errorf("无法读取素材 %q，请确认项目文件可用后重新生成", path)
	}
	return digest, nil
}

func openLocalReference(workspace, path string, stable bool) (*os.File, error) {
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, errors.New("Could not open the reference workspace")
	}
	defer root.Close()
	file, err := root.Open(path)
	if err != nil {
		return nil, fmt.Errorf("无法打开项目素材 %q，请重新连接可用的素材", path)
	}
	if !stable {
		return file, nil
	}
	readonly, err := reopenMediaReadOnly(file)
	file.Close()
	if err != nil {
		return nil, fmt.Errorf("无法稳定读取素材 %q，请关闭正在编辑该文件的程序后重新生成", path)
	}
	return readonly, nil
}

func localMediaSHA256(file *os.File) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func openProviderReference(input GenerationInput, ref GenerationReference, limit int64) (*os.File, error) {
	file, err := openLocalReference(input.WorkspacePath, ref.Path, ref.LocalSHA256 != "")
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		file.Close()
		return nil, fmt.Errorf("项目素材 %q 超出渠道大小限制或不可读取", ref.Path)
	}
	if ref.LocalSHA256 != "" {
		digest, err := localMediaSHA256(file)
		if err != nil || digest != ref.LocalSHA256 {
			file.Close()
			return nil, fmt.Errorf("项目素材 %q 无法匹配冻结的文件内容，请从当前 Canvas 节点重新生成", ref.Path)
		}
	}
	return file, nil
}

type videoEdgeReference struct {
	GenerationReference
	assetID string
}

func videoEdgeReferences(ctx context.Context, tx *sql.Tx, workspace, target string, order []string) ([]videoEdgeReference, error) {
	rows, err := tx.QueryContext(ctx, `SELECT source,nodes.type,nodes.content,nodes.revision,nodes.deleted
		FROM edges LEFT JOIN nodes ON nodes.id=source WHERE target=? ORDER BY edges.rowid`, target)
	if err != nil {
		return nil, err
	}
	var sources []Node
	for rows.Next() {
		var node Node
		var kind, raw sql.NullString
		var rev sql.NullInt64
		var deleted sql.NullBool
		if err := rows.Scan(&node.ID, &kind, &raw, &rev, &deleted); err != nil {
			rows.Close()
			return nil, err
		}
		if !kind.Valid {
			rows.Close()
			return nil, invalid("视频节点 %s 的入边来源 %s 已不存在，请移除或重连", target, node.ID)
		}
		if isVideoMedia(kind.String) {
			node.Type, node.Content, node.Revision, node.Deleted = kind.String, json.RawMessage(raw.String), rev.Int64, deleted.Bool
			sources = append(sources, node)
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}

	byID := make(map[string]Node, len(sources))
	for _, node := range sources {
		byID[node.ID] = node
	}
	// mixedListOrder is a sort preference. The edge table defines membership.
	ordered := slices.Clone(order)
	for _, node := range sources {
		ordered = append(ordered, node.ID)
	}
	var refs []videoEdgeReference
	for _, id := range ordered {
		node, ok := byID[id]
		if !ok {
			continue
		}
		delete(byID, id)
		resolved, ref, err := resolveVideoEdgeMedia(ctx, tx, workspace, node)
		var invalidMedia *requestError
		if errors.As(err, &invalidMedia) {
			return nil, invalid("视频节点 %s 的素材 %s：%s", target, id, invalidMedia.Error())
		}
		if err != nil {
			return nil, err
		}
		ref.SourceNodeID, ref.SourceRevision = node.ID, node.Revision
		if resolved.ID != node.ID {
			ref.ResultNodeID, ref.ResultRevision = resolved.ID, resolved.Revision
		}
		var metadata struct{ AssetID string }
		_ = json.Unmarshal(resolved.Content, &metadata)
		refs = append(refs, videoEdgeReference{GenerationReference: ref, assetID: metadata.AssetID})
	}
	return refs, nil
}

func resolveVideoEdgeMedia(ctx context.Context, tx *sql.Tx, workspace string, source Node) (Node, GenerationReference, error) {
	if source.Deleted {
		return Node{}, GenerationReference{}, invalid("来源卡片已删除，请重新连接可用的素材")
	}
	resolved, err := resolveMediaNode(ctx, tx, source)
	if err != nil {
		return Node{}, GenerationReference{}, err
	}
	if resolved.ID == "" {
		return Node{}, GenerationReference{}, invalid("来源尚无可用产物，请生成产物或连接具体素材")
	}
	ref, err := mediaGenerationReference(resolved.NodeInput)
	if err != nil {
		return Node{}, GenerationReference{}, err
	}
	if ref.Path != "" {
		if err := validateNode(resolved.NodeInput); err != nil {
			return Node{}, GenerationReference{}, err
		}
		root, err := os.OpenRoot(workspace)
		if err != nil {
			return Node{}, GenerationReference{}, err
		}
		defer root.Close()
		info, err := root.Stat(ref.Path)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return Node{}, GenerationReference{}, invalid("项目文件 %q 已失效，请重新连接可用的素材", ref.Path)
		}
	}
	return resolved, ref, nil
}

func resolveVideoMentions(target, prompt string, linked bool, raw json.RawMessage, refs []videoEdgeReference) ([]GenerationPromptMention, error) {
	doc, err := parsePromptDoc(raw)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, nil
	}
	var atoms []assetMention
	var spans []GenerationPromptMention
	projected, err := doc.render(false, func(mention assetMention, start int) (string, error) {
		token := assetMentionText(mention)
		atoms = append(atoms, mention)
		spans = append(spans, GenerationPromptMention{Start: start, End: start + len(token), Type: mention.AssetType})
		return token, nil
	})
	if err != nil || len(atoms) == 0 {
		return nil, err
	}
	if projected != prompt {
		if linked {
			return nil, invalid("视频节点 %s 的正文与素材引用「%s」不一致，请重新选择引用或转为普通文字后保存", target, mentionLabel(atoms[0]))
		}
		return nil, nil // Older detached metadata has no authority over the prompt.
	}
	for i, atom := range atoms {
		var direct, matched, ordinal int
		for _, ref := range refs {
			if atom.AssetType != ref.Type {
				continue
			}
			ordinal++
			if atom.AssetID == ref.SourceNodeID {
				direct = ordinal
			}
			if atom.AssetID == ref.ResultNodeID || atom.AssetID == ref.assetID {
				if matched != 0 {
					matched = -1
				} else {
					matched = ordinal
				}
			}
		}
		if direct != 0 {
			matched = direct
		}
		if matched <= 0 {
			return nil, invalid("视频节点 %s 的引用「%s」(%s) 没有唯一的有效媒体入边，请重新连接、重新选择或转为普通文字",
				target, mentionLabel(atom), atom.AssetID)
		}
		spans[i].Ordinal = matched
	}
	return spans, nil
}

func videoRequestPrompt(input GenerationInput, format func(GenerationPromptMention) string) (string, error) {
	if len(input.PromptMentions) == 0 {
		return input.Prompt, nil
	}
	counts := make(map[string]int)
	for _, ref := range input.References {
		counts[ref.Type]++
	}
	var result strings.Builder
	previous := 0
	for _, mention := range input.PromptMentions {
		if mention.Start < previous || mention.Start >= mention.End || mention.End > len(input.Prompt) ||
			mention.Ordinal < 1 || mention.Ordinal > counts[mention.Type] ||
			!utf8.ValidString(input.Prompt[mention.Start:mention.End]) || input.Prompt[mention.Start] != '@' {
			return "", invalid("任务的冻结素材引用无效，请从当前视频节点重新生成")
		}
		result.WriteString(input.Prompt[previous:mention.Start])
		token := format(mention)
		result.WriteString(token)
		if len(token) > 0 && mention.End < len(input.Prompt) &&
			token[len(token)-1] >= '0' && token[len(token)-1] <= '9' &&
			input.Prompt[mention.End] >= '0' && input.Prompt[mention.End] <= '9' {
			result.WriteByte(' ')
		}
		previous = mention.End
	}
	result.WriteString(input.Prompt[previous:])
	return result.String(), nil
}
