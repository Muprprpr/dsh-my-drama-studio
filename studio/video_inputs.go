package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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
	refs, err := videoEdgeReferences(ctx, tx, id, content.Order)
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
	for i := range input.References {
		ref := &input.References[i]
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

func (p *project) prepareVideoMedia(ctx context.Context, nodeID string, input *GenerationInput) error {
	type localMedia struct {
		file   *os.File
		size   int64
		mime   string
		digest string
	}
	opened := make(map[string]*localMedia)
	protocol := input.Profile.Provider
	inline := protocol == "openai-video" || protocol == "new-api" || protocol == "custom-rest"
	ark := protocol == "ark" || protocol == "byteplus"
	remaining := videoInlineMediaLimit(protocol)
	var arkRemaining int64
	if ark {
		prompt, err := arkRequestPrompt(input.Profile, *input)
		if err != nil {
			return err
		}
		arkRemaining = int64(arkMaxBodyBytes - len(prompt))
	}
	for _, ref := range input.References {
		if err := ctx.Err(); err != nil {
			return err
		}
		if ref.Path == "" && ark {
			arkRemaining -= int64(len(ref.URL))
		}
		if ref.Path != "" {
			media := opened[ref.Path]
			if media == nil {
				file, mime, err := openVideoInputMedia(*input, ref, remaining)
				if err != nil {
					return invalid("视频节点 %s 的素材 %s：%s", nodeID, ref.SourceNodeID, err)
				}
				defer file.Close()
				info, err := file.Stat()
				if err != nil {
					return invalid("视频节点 %s 的素材 %s：无法读取项目文件大小", nodeID, ref.SourceNodeID)
				}
				media = &localMedia{file: file, mime: mime, size: info.Size()}
				opened[ref.Path] = media
			}
			if inline {
				remaining -= media.size
				if remaining < 0 {
					return invalid("视频节点 %s 的本地素材合计超过所选渠道大小限制", nodeID)
				}
			}
			if ark {
				arkRemaining -= int64(len("data:") + len(media.mime) + len(";base64,") +
					base64.StdEncoding.EncodedLen(int(media.size)))
			}
		}
		if ark && arkRemaining <= 0 {
			return invalid("视频节点 %s 的素材超过方舟请求大小限制", nodeID)
		}
	}
	if ratio := input.productionAspectRatio; ratio != "" && input.Params.AspectRatio == "" &&
		videoInheritsFirstFrameRatio(input.Mode, input.Profile) {
		first := opened[input.References[0].Path]
		if first == nil {
			return invalid("该模型从首帧继承画幅，请使用可核对画幅的项目内 PNG 或 JPEG 首帧")
		}
		if err := checkProductionFirstFrame(first.file, ratio); err != nil {
			return err
		}
		if _, err := first.file.Seek(0, io.SeekStart); err != nil {
			return invalid("无法重新读取首帧图片")
		}
	}
	hash := localMediaSHA256
	if p.hashVideoMedia != nil {
		hash = p.hashVideoMedia
	}
	for i := range input.References {
		ref := &input.References[i]
		media := opened[ref.Path]
		if media == nil {
			continue
		}
		if media.digest == "" {
			digest, err := hash(ctx, media.file)
			if err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return invalid("视频节点 %s 的素材 %s：无法读取项目文件 %q，请核对后重新生成", nodeID, ref.SourceNodeID, ref.Path)
			}
			media.digest = digest
		}
		ref.LocalSHA256 = media.digest
	}
	return nil
}

func openVideoInputMedia(input GenerationInput, ref GenerationReference, inlineRemaining int64) (*os.File, string, error) {
	switch input.Profile.Provider {
	case "ark", "byteplus":
		return openImageReference(input, ref, arkMaxImageBytes-1, true)
	case "replicate":
		return openReplicateImage(input.Profile, input, ref, true)
	case minimaxH3Protocol:
		media, err := openMinimaxMedia(input, ref, true)
		return media.file, "", err
	case "openai-video", "new-api", "custom-rest":
		return readVideoMedia(input, ref, inlineRemaining, true)
	default:
		file, err := openProviderReference(input, ref, math.MaxInt64, true)
		return file, "", err
	}
}

func openLocalReference(workspace, path string, stable bool) (*os.File, error) {
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, errors.New("Could not open the reference workspace")
	}
	defer root.Close()
	file, err := root.Open(path)
	if err != nil {
		return nil, fmt.Errorf("无法打开项目文件 %q，请重新连接可用的素材", path)
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

func localMediaSHA256(ctx context.Context, file *os.File) (string, error) {
	hash := sha256.New()
	buffer := make([]byte, 64<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, err := file.Read(buffer)
		_, _ = hash.Write(buffer[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func openProviderReference(input GenerationInput, ref GenerationReference, limit int64, stable bool) (*os.File, error) {
	file, err := openLocalReference(input.WorkspacePath, ref.Path, stable || ref.LocalSHA256 != "")
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		file.Close()
		return nil, fmt.Errorf("项目素材 %q 超出渠道大小限制或不可读取", ref.Path)
	}
	if ref.LocalSHA256 != "" {
		digest, err := localMediaSHA256(context.Background(), file)
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

func videoEdgeReferences(ctx context.Context, tx *sql.Tx, target string, order []string) ([]videoEdgeReference, error) {
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
		resolved, ref, err := readVideoEdgeMedia(ctx, tx, node)
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
	resolved, ref, err := readVideoEdgeMedia(ctx, tx, source)
	if err != nil {
		return Node{}, GenerationReference{}, err
	}
	if ref.Path != "" {
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

func readVideoEdgeMedia(ctx context.Context, tx *sql.Tx, source Node) (Node, GenerationReference, error) {
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
