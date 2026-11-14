package studio

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

var assetMentionLabels = map[string]string{"image": "图片", "video": "视频", "audio": "音频"}

type assetMention struct {
	AssetID   string `json:"assetId"`
	AssetType string `json:"assetType"`
	Label     string `json:"label"`
}

type promptElement struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	Attrs   json.RawMessage `json:"attrs"`
	Content []promptElement `json:"content"`
}

func parsePromptDoc(raw json.RawMessage) (*promptElement, error) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var doc promptElement
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Type != "doc" || doc.Text != "" || len(doc.Attrs) != 0 {
		return nil, invalid("提示词文档格式无效")
	}
	_, err := doc.render(func(assetMention) (string, error) { return "", nil })
	return &doc, err
}

func (doc *promptElement) render(mention func(assetMention) (string, error)) (string, error) {
	var prompt strings.Builder
	for index, paragraph := range doc.Content {
		if paragraph.Type != "paragraph" || paragraph.Text != "" || len(paragraph.Attrs) != 0 {
			return "", invalid("提示词文档只支持纯文本段落")
		}
		if index > 0 {
			prompt.WriteByte('\n')
		}
		for _, part := range paragraph.Content {
			if len(part.Content) != 0 {
				return "", invalid("提示词行内内容格式无效")
			}
			switch part.Type {
			case "text":
				if len(part.Attrs) != 0 {
					return "", invalid("提示词文本格式无效")
				}
				prompt.WriteString(part.Text)
			case "hardBreak":
				if part.Text != "" || len(part.Attrs) != 0 {
					return "", invalid("提示词换行格式无效")
				}
				prompt.WriteByte('\n')
			case "assetMention":
				data, err := parseAssetMention(part.Attrs)
				if err != nil || part.Text != "" {
					return "", invalid("提示词提及必须引用项目图片、视频或音频的素材 ID")
				}
				token, err := mention(data)
				if err != nil {
					return "", err
				}
				prompt.WriteString(token)
			default:
				return "", invalid("提示词文档包含不支持的行内内容")
			}
		}
	}
	return prompt.String(), nil
}

func parseAssetMention(raw json.RawMessage) (assetMention, error) {
	var data assetMention
	if err := decodeData(raw, &data); err != nil || !isVideoMedia(data.AssetType) || len(data.Label) > 640 ||
		strings.ContainsAny(data.Label, "\r\n") {
		return data, invalid("素材提及格式无效")
	}
	if !importedAssetID.MatchString(data.AssetID) {
		id, err := uuid.Parse(data.AssetID)
		if err != nil || id.String() != data.AssetID {
			return data, invalid("素材 ID 无效")
		}
	}
	return data, nil
}

// Keep a plain inline prompt for existing consumers of content.prompt.
func normalizePromptDoc(kind string, raw json.RawMessage) (json.RawMessage, error) {
	if kind != "image" && kind != "video" && kind != "prompt" {
		return raw, nil
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal(raw, &content); err != nil {
		return raw, err
	}
	doc, err := parsePromptDoc(content["promptDoc"])
	if err != nil || doc == nil || kind == "prompt" {
		// Prompt notes preserve their existing text/description/prompt field.
		return raw, err
	}
	plain, err := doc.render(func(data assetMention) (string, error) {
		label := data.Label
		if label == "" {
			label = assetMentionLabels[data.AssetType]
		}
		return "@" + label, nil
	})
	if err != nil {
		return nil, err
	}
	content["prompt"], _ = json.Marshal(plain)
	return json.Marshal(content)
}

// Look up the original project asset. The graph card may be archived, while
// the asset keeps the same identity and remains available in the project.
func mentionedAsset(ctx context.Context, tx *sql.Tx, workspace string, mention assetMention) (Node, GenerationReference, error) {
	query := "SELECT " + nodeColumns + ` FROM nodes WHERE type=? AND id=?
		AND (json_extract(content,'$.path') <> '' OR json_extract(content,'$.url') <> '')`
	if importedAssetID.MatchString(mention.AssetID) {
		query = "SELECT " + nodeColumns + ` FROM nodes WHERE type=? AND json_extract(content,'$.assetId')=?
			ORDER BY deleted,rowid DESC LIMIT 1`
	}
	asset, err := scanNode(tx.QueryRowContext(ctx, query, mention.AssetType, mention.AssetID))
	if errors.Is(err, sql.ErrNoRows) {
		return Node{}, GenerationReference{}, invalid("提及的素材「%s」不存在或类型已变更", mentionLabel(mention))
	}
	if err != nil {
		return Node{}, GenerationReference{}, err
	}
	ref, err := mediaGenerationReference(asset.NodeInput)
	if err != nil {
		return Node{}, ref, err
	}
	if ref.Path != "" {
		root, err := os.OpenRoot(workspace)
		if err != nil {
			return Node{}, ref, err
		}
		defer root.Close()
		info, err := root.Stat(ref.Path)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return Node{}, ref, invalid("找不到素材「%s」的项目文件", mentionLabel(mention))
		}
	}
	return asset, ref, nil
}

func mentionLabel(mention assetMention) string {
	if strings.TrimSpace(mention.Label) == "" {
		return mention.AssetID
	}
	return mention.Label
}

// Provider adapters already understand ordered image, video and audio inputs.
// Keep graph references in their established slots, extending by first mention.
func compileAssetMentions(ctx context.Context, tx *sql.Tx, workspace string, target NodeInput, input *GenerationInput, doc *promptElement) ([]string, error) {
	var sources []string
	targetRef, _ := mediaGenerationReference(target)
	ordinals := make(map[assetMention]string)
	prompt, err := doc.render(func(mention assetMention) (string, error) {
		key := assetMention{AssetType: mention.AssetType, AssetID: mention.AssetID}
		if token, ok := ordinals[key]; ok {
			return token, nil
		}
		if input.Type == "image" && mention.AssetType != "image" {
			return "", invalid("图片生成只支持提及图片素材")
		}
		asset, ref, err := mentionedAsset(ctx, tx, workspace, mention)
		if err != nil {
			return "", err
		}
		if asset.ID == target.ID || referenceOrdinal([]GenerationReference{targetRef}, ref) != 0 {
			return "", invalid("生成节点不能提及自身的素材")
		}
		ordinal := referenceOrdinal(input.References, ref)
		if ordinal == 0 {
			input.References = append(input.References, ref)
			ordinal = referenceOrdinal(input.References, ref)
		}
		token := "@" + assetMentionLabels[ref.Type] + strconv.Itoa(ordinal)
		sources = append(sources, asset.ID)
		ordinals[key] = token
		return token, nil
	})
	input.Prompt = prompt
	return sources, err
}

func referenceOrdinal(ordered []GenerationReference, ref GenerationReference) int {
	ordinal := 0
	for _, prior := range ordered {
		if prior.Type != ref.Type {
			continue
		}
		ordinal++
		if ref.Path != "" && ref.Path == prior.Path || ref.Path == "" && prior.Path == "" && ref.URL == prior.URL {
			return ordinal
		}
	}
	return 0
}

func (p *project) projectMentionedAssets(ctx context.Context, tx *sql.Tx, result *queryResult) error {
	seen := make(map[assetMention]bool)
	for _, node := range result.Nodes {
		if node.Type != "image" && node.Type != "video" && node.Type != "prompt" {
			continue
		}
		var content struct {
			PromptDoc json.RawMessage
		}
		if err := json.Unmarshal(node.Content, &content); err != nil || len(content.PromptDoc) == 0 {
			continue
		}
		doc, err := parsePromptDoc(content.PromptDoc)
		if err != nil || doc == nil {
			continue
		}
		_, err = doc.render(func(mention assetMention) (string, error) {
			key := assetMention{AssetType: mention.AssetType, AssetID: mention.AssetID}
			if seen[key] {
				return "", nil
			}
			seen[key] = true
			asset, _, err := mentionedAsset(ctx, tx, p.dir, mention)
			var bad *requestError
			if errors.As(err, &bad) {
				return "", nil
			}
			if err != nil {
				return "", err
			}
			if result.MentionedAssets == nil {
				result.MentionedAssets = make(map[string]Node)
			}
			result.MentionedAssets[mention.AssetID] = asset
			return "", nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
