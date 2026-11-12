package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const (
	minimaxH3Protocol = "minimax-h3"
	minimaxH3Model    = "MiniMax-H3"
	minimaxH3BaseURL  = "https://metaso.cn/api/minimax"
	minimaxH3Submit   = "/v2/video_generation"
	minimaxH3Query    = "/v2/query/video_generation/"
	minimaxH3Upload   = "/v1/files/upload"
	minimaxH3Balance  = "/v2/credits/balance"
)

var minimaxRatios = []string{"adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"}
var minimaxReferenceLimits = map[string]int{"image": 9, "video": 3, "audio": 3}
var minimaxFileLimits = map[string]int64{"image": 30 << 20, "video": 50 << 20, "audio": 15 << 20}

type minimaxProvider struct {
	videoHTTP
	profile ProviderProfile
}

func newMinimaxProvider(profile ProviderProfile, key string, client *http.Client) Provider {
	channel := VideoChannel{Protocol: minimaxH3Protocol, BaseURL: minimaxH3BaseURL}
	return &minimaxProvider{videoHTTP: newVideoHTTP(channel, key, client), profile: profile}
}

func minimaxSupportsMode(mode string) bool {
	return mode == "t2v" || mode == "i2v" || mode == "r2v"
}

func minimaxResolution(value string) bool {
	return strings.EqualFold(value, "768P") || strings.EqualFold(value, "2K")
}

func validateMinimaxModel(profile ProviderProfile) error {
	if profile.Model != minimaxH3Model {
		return fmt.Errorf("秘塔原生渠道的模型 ID 必须是 %s", minimaxH3Model)
	}
	if profile.Mode != "" && !minimaxSupportsMode(profile.Mode) {
		return errors.New("MiniMax H3 支持 T2V、I2V 和 R2V")
	}
	for _, mode := range profile.Modes {
		if !minimaxSupportsMode(mode) {
			return errors.New("MiniMax H3 支持 T2V、I2V 和 R2V")
		}
	}
	limits, defaults := profile.Limits, profile.Defaults
	if limits.GenerateAudio || defaults.GenerateAudio != nil {
		return errors.New("MiniMax H3 不提供独立的音频生成开关")
	}
	if limits.DurationMin != 0 && !minimaxDuration(limits.DurationMin) ||
		limits.DurationMax != 0 && !minimaxDuration(limits.DurationMax) ||
		defaults.Duration != 0 && !minimaxDuration(defaults.Duration) {
		return errors.New("MiniMax H3 的生成时长为 4–15 秒")
	}
	for _, duration := range limits.Durations {
		if !minimaxDuration(duration) {
			return errors.New("MiniMax H3 的生成时长为 4–15 秒")
		}
	}
	if defaults.Resolution != "" && !minimaxResolution(defaults.Resolution) {
		return errors.New("MiniMax H3 的输出分辨率为 768P 或 2K")
	}
	for _, resolution := range limits.Resolutions {
		if !minimaxResolution(resolution) {
			return errors.New("MiniMax H3 的输出分辨率为 768P 或 2K")
		}
	}
	if defaults.AspectRatio != "" && !slices.Contains(minimaxRatios, defaults.AspectRatio) {
		return errors.New("MiniMax H3 不支持此默认画幅")
	}
	for _, ratio := range limits.AspectRatios {
		if !slices.Contains(minimaxRatios, ratio) {
			return errors.New("MiniMax H3 不支持此画幅")
		}
	}
	for kind, count := range limits.References {
		if count > minimaxReferenceLimits[kind] {
			return fmt.Errorf("MiniMax H3 %s 参考素材最多允许 %d 个", kind, minimaxReferenceLimits[kind])
		}
	}
	if limits.MaxReferences > 15 {
		return errors.New("MiniMax H3 最多允许 15 个参考素材")
	}
	return nil
}

func minimaxDuration(value int) bool { return value >= 4 && value <= 15 }

func minimaxParams(input GenerationInput) VideoParams {
	params := input.Params
	if params.Duration == 0 {
		params.Duration = 4
	}
	if params.Resolution == "" {
		params.Resolution = "768P"
	}
	if input.Mode == "t2v" && params.AspectRatio == "" {
		params.AspectRatio = "16:9"
	}
	return params
}

func (p *minimaxProvider) Validate(input GenerationInput) error {
	if err := validateMinimaxModel(p.profile); err != nil {
		return err
	}
	if input.Type != "video" || strings.TrimSpace(input.Prompt) == "" {
		return errors.New("MiniMax H3 需要完整的视频提示词")
	}
	if !minimaxSupportsMode(input.Mode) || p.profile.Mode != "" && input.Mode != p.profile.Mode {
		return errors.New("MiniMax H3 的模型预设与请求模式不匹配")
	}
	params := minimaxParams(input)
	if !minimaxDuration(params.Duration) || !minimaxResolution(params.Resolution) {
		return errors.New("MiniMax H3 需要 4–15 秒和 768P 或 2K 分辨率")
	}
	if params.GenerateAudio != nil {
		return errors.New("MiniMax H3 不提供独立的音频生成开关")
	}
	if params.AspectRatio != "" && !slices.Contains(minimaxRatios, params.AspectRatio) ||
		input.Mode == "t2v" && params.AspectRatio == "adaptive" {
		return errors.New("MiniMax H3 的文生视频需要指定画幅")
	}
	count := len(input.References)
	switch input.Mode {
	case "t2v":
		if count != 0 {
			return errors.New("MiniMax H3 T2V 只接受提示词")
		}
	case "i2v":
		if count == 0 || count > 2 || count == 2 && !p.profile.Limits.LastFrame {
			return errors.New("MiniMax H3 I2V 需要一张首帧图片，并可按预设使用一张尾帧图片")
		}
	case "r2v":
		if count == 0 {
			return errors.New("MiniMax H3 R2V 需要参考图片、视频或音频")
		}
	}
	counts := make(map[string]int)
	for _, ref := range input.References {
		counts[ref.Type]++
		if input.Mode == "i2v" && ref.Type != "image" || counts[ref.Type] > minimaxReferenceLimits[ref.Type] {
			return errors.New("MiniMax H3 的参考素材类型或数量超出限制")
		}
		if ref.URL != "" && !providerURL(ref.URL) || ref.URL == "" && ref.Path == "" {
			return errors.New("MiniMax H3 参考素材需要项目文件或可访问的 HTTP/HTTPS 地址")
		}
	}
	return nil
}

func (p *minimaxProvider) Submit(ctx context.Context, input GenerationInput) (ProviderSubmission, error) {
	if err := p.Validate(input); err != nil {
		return ProviderSubmission{Rejected: true}, err
	}
	content := []map[string]any{{"type": "text", "text": input.Prompt}}
	for index, ref := range input.References {
		mediaURL := ref.URL
		if mediaURL == "" {
			var err error
			mediaURL, err = p.upload(ctx, input, ref)
			if err != nil {
				return ProviderSubmission{Rejected: true}, err
			}
		}
		role := "reference_" + ref.Type
		if input.Mode == "i2v" {
			role = []string{"first_frame", "last_frame"}[index]
		}
		field := ref.Type + "_url"
		content = append(content, map[string]any{"type": field, "role": role, field: map[string]string{"url": mediaURL}})
	}
	params := minimaxParams(input)
	body := map[string]any{
		"model": p.profile.Model, "content": content,
		"duration": params.Duration, "resolution": strings.ToUpper(params.Resolution),
	}
	if input.Mode != "i2v" && params.AspectRatio != "" {
		body["ratio"] = params.AspectRatio
	}
	response, err := p.json(ctx, http.MethodPost, p.endpoint(minimaxH3Submit), body)
	if err != nil {
		return ProviderSubmission{Rejected: submissionRejected(err)}, err
	}
	if id := videoTaskID(response["task_id"]); id != "" {
		return ProviderSubmission{TaskID: id}, nil
	}
	if message := minimaxResponseError(response); message != "" {
		return ProviderSubmission{Rejected: true}, errors.New(p.safeMessage(message))
	}
	return ProviderSubmission{}, errors.New("MiniMax H3 未返回有效任务 ID，提交结果未知")
}

// The multipart envelope stays in memory while the local asset streams from disk.
type minimaxMultipart struct {
	io.Reader
	size int64
}

func (b minimaxMultipart) Size() int64 { return b.size }

func (p *minimaxProvider) upload(ctx context.Context, input GenerationInput, ref GenerationReference) (string, error) {
	file, mime, err := readVideoMedia(input, ref, minimaxFileLimits[ref.Type])
	if err != nil {
		return "", err
	}
	defer file.Close()
	if !slices.Contains([]string{"image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime", "audio/wav", "audio/mpeg"}, mime) {
		return "", errors.New("MiniMax H3 参考素材支持 PNG、JPEG、WebP、MP4、MOV、WAV 或 MP3")
	}
	local, ok := file.(interface{ Stat() (os.FileInfo, error) })
	if !ok {
		return "", errors.New("无法读取 MiniMax H3 素材的文件大小")
	}
	info, err := local.Stat()
	if err != nil || info.Size() <= 0 || info.Size() > minimaxFileLimits[ref.Type] {
		return "", errors.New("MiniMax H3 参考素材不可读或超出大小限制")
	}
	var envelope bytes.Buffer
	writer := multipart.NewWriter(&envelope)
	if err := writer.WriteField("purpose", "video_generation_input"); err != nil {
		return "", err
	}
	if _, err := writer.CreateFormFile("file", "reference"+strings.ToLower(filepath.Ext(ref.Path))); err != nil {
		return "", err
	}
	prefixLength := envelope.Len()
	if err := writer.Close(); err != nil {
		return "", err
	}
	prefix, suffix := envelope.Bytes()[:prefixLength], envelope.Bytes()[prefixLength:]
	body := minimaxMultipart{
		Reader: io.MultiReader(bytes.NewReader(prefix), io.LimitReader(file, info.Size()), bytes.NewReader(suffix)),
		size:   int64(envelope.Len()) + info.Size(),
	}
	response, err := p.request(ctx, http.MethodPost, p.endpoint(minimaxH3Upload), writer.FormDataContentType(), body)
	if err != nil {
		return "", err
	}
	data, err := p.jsonResponse(response)
	if err != nil {
		return "", err
	}
	if message := minimaxResponseError(data); message != "" {
		return "", errors.New(p.safeMessage(message))
	}
	uploaded, _ := data["file"].(map[string]any)
	if id := videoTaskID(uploaded["file_id"]); id != "" {
		return "mm_file://" + id, nil
	}
	if downloadURL, _ := uploaded["download_url"].(string); providerURL(downloadURL) {
		return downloadURL, nil
	}
	return "", errors.New("MiniMax H3 上传接口未返回有效的文件 ID 或下载地址")
}

func (p *minimaxProvider) Poll(ctx context.Context, id string) (ProviderResult, error) {
	if videoTaskID(id) == "" {
		return ProviderResult{}, permanentProviderError("MiniMax H3 任务 ID 无效")
	}
	response, err := p.json(ctx, http.MethodGet, p.endpoint(minimaxH3Query+url.PathEscape(id)), nil)
	if err != nil {
		return ProviderResult{}, err
	}
	if message := minimaxResponseError(response); message != "" {
		return ProviderResult{}, permanentProviderError(p.safeMessage(message))
	}
	task, _ := response["task"].(map[string]any)
	if videoTaskID(task["id"]) != id {
		return ProviderResult{}, permanentProviderError("MiniMax H3 返回了无效或不匹配的任务 ID")
	}
	status, _ := task["status"].(string)
	switch strings.ToLower(status) {
	case "queued":
		return ProviderResult{Status: "pending"}, nil
	case "running":
		return ProviderResult{Status: "running"}, nil
	case "failed", "cancelled", "canceled", "expired":
		message := providerMessage(task)
		if message == "" {
			message = "MiniMax H3 任务结束，供应商状态为 " + status
		}
		if strings.EqualFold(status, "cancelled") || strings.EqualFold(status, "canceled") {
			return ProviderResult{Status: "cancelled", Error: p.safeMessage(message)}, nil
		}
		return ProviderResult{Status: "failed", Error: p.safeMessage(message)}, nil
	case "succeeded":
		content, _ := task["content"].(map[string]any)
		output, _ := content["url"].(string)
		parsed, err := url.Parse(output)
		if err != nil || parsed.Scheme != "https" || !providerURL(output) {
			return ProviderResult{}, permanentProviderError("MiniMax H3 任务成功但未返回有效的 HTTPS 视频地址")
		}
		return ProviderResult{Status: "succeeded", URL: output, Extension: ".mp4"}, nil
	default:
		return ProviderResult{}, permanentProviderError("MiniMax H3 返回未知的任务状态 " + p.safeMessage(status))
	}
}

func (p *minimaxProvider) Download(ctx context.Context, result ProviderResult, writer io.Writer) error {
	return p.downloadExternal(ctx, result, writer)
}

func (p *minimaxProvider) Verify(ctx context.Context) error {
	response, err := p.json(ctx, http.MethodGet, p.endpoint(minimaxH3Balance), nil)
	if err != nil {
		return err
	}
	if message := minimaxResponseError(response); message != "" {
		return errors.New(p.safeMessage(message))
	}
	value, ok := response["balance"].(json.Number)
	if !ok {
		return errors.New("秘塔余额接口未返回可用于验证鉴权的余额字段")
	}
	if balance, err := value.Float64(); err != nil || balance < 0 {
		return errors.New("秘塔余额接口返回的余额无效")
	}
	return nil
}

func minimaxResponseError(data map[string]any) string {
	if problem, ok := data["error"].(map[string]any); ok && len(problem) > 0 {
		if message, _ := problem["message"].(string); strings.TrimSpace(message) != "" {
			return message
		}
		return "MiniMax H3 返回服务错误"
	}
	base, _ := data["base_resp"].(map[string]any)
	if code, _ := base["status_code"].(json.Number); code != "" && code != "0" {
		if message, _ := base["status_msg"].(string); strings.TrimSpace(message) != "" {
			return message
		}
		return "MiniMax H3 返回服务错误，代码 " + code.String()
	}
	return ""
}
