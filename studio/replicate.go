package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	replicateAPI        = "https://api.replicate.com/v1"
	replicateImageLimit = 20 << 20
)

var (
	replicateModelName  = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
	replicateVersion    = regexp.MustCompile("^[0-9a-f]{64}$")
	replicateIdentifier = regexp.MustCompile("^[A-Za-z0-9_-]+$")
	replicateField      = regexp.MustCompile("^[A-Za-z][A-Za-z0-9_]*$")
	klingImageToken     = regexp.MustCompile(`(?i)@(图片|image)[ \t]*([0-9]+)`)
)

type replicateProvider struct {
	profile  ProviderProfile
	apiKey   string
	api      http.Client
	download http.Client
}

func newReplicateProvider(profile ProviderProfile, apiKey string, client *http.Client) Provider {
	if client == nil {
		client = http.DefaultClient
	}
	provider := &replicateProvider{profile: profile, apiKey: strings.TrimSpace(apiKey), api: *client, download: *client}
	provider.api.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	provider.download.CheckRedirect = func(next *http.Request, chain []*http.Request) error {
		if len(chain) >= 5 || !replicateDelivery(next.URL) {
			return http.ErrUseLastResponse
		}
		next.Header.Set("Authorization", "Bearer "+provider.apiKey)
		next.Header.Del("Referer")
		return nil
	}
	return provider
}

type replicatePredictionInput struct {
	Version string         `json:"version,omitempty"`
	Input   map[string]any `json:"input"`
}

type replicatePrediction struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Output json.RawMessage `json:"output"`
	Error  json.RawMessage `json:"error"`
}

func replicateRequest(profile ProviderProfile, input GenerationInput) (string, replicatePredictionInput, error) {
	endpoint := "/predictions"
	model := strings.TrimSpace(profile.Model)
	body := replicatePredictionInput{Input: make(map[string]any, len(profile.Options)+4)}
	name, version, hasVersion := strings.Cut(model, ":")
	switch {
	case hasVersion && replicateModelName.MatchString(name) && replicateVersion.MatchString(version):
		body.Version = model
	case replicateVersion.MatchString(model):
		body.Version = model
	case replicateModelName.MatchString(model):
		endpoint = "/models/" + model + "/predictions"
	default:
		return "", body, errors.New("Replicate 模型须使用 owner/name、owner/name:版本或完整版本 ID")
	}

	mode := profile.Mode
	if input.Mode != "" && input.Mode != mode {
		return "", body, errors.New("Replicate 配置与生成方式不匹配")
	}
	if (mode == "t2i" && input.Type != "image") || (mode != "t2i" && input.Type != "video") {
		return "", body, errors.New("Replicate 配置与生成节点类型不匹配")
	}
	if strings.TrimSpace(input.Prompt) == "" {
		return "", body, errors.New("Replicate 需要节点内的完整提示词")
	}

	mediaField := profile.InputField
	switch mode {
	case "t2i", "t2v":
		if len(input.References) != 0 || mediaField != "" {
			return "", body, errors.New("纯文生成无需媒体输入")
		}
	case "i2v":
		if len(input.References) != 1 {
			return "", body, errors.New("图生视频需要一张首帧图片")
		}
	case "r2v":
		if len(input.References) == 0 {
			return "", body, errors.New("参考生视频至少需要一张参考图片")
		}
	default:
		return "", body, errors.New("Replicate 仅支持 T2I、T2V、I2V 和 R2V")
	}
	if len(input.References) != 0 {
		field := strings.ToLower(mediaField)
		if !replicateField.MatchString(mediaField) || strings.Contains(field, "prompt") ||
			strings.Contains(field, "text") || strings.Contains(field, "video") || strings.Contains(field, "audio") ||
			field == "duration" || field == "aspect_ratio" {
			return "", body, errors.New("请填写模型文档中明确的图片输入字段")
		}
	}
	for _, ref := range input.References {
		if ref.Type != "image" || (ref.URL == "" && ref.Path == "") {
			return "", body, errors.New("Replicate 视频输入只接受已连接的图片素材")
		}
		if ref.URL != "" && !providerURL(ref.URL) {
			return "", body, errors.New("图片需要可访问的外部 HTTP/HTTPS 地址")
		}
		if ref.URL == "" && (!filepath.IsLocal(ref.Path) || !strings.HasPrefix(ref.Path, "assets/images/") ||
			strings.Contains(ref.Path, "\\") || path.Clean(ref.Path) != ref.Path) {
			return "", body, errors.New("本地参考图片须位于项目的 assets/images 目录")
		}
	}
	for field, option := range profile.Options {
		if !replicateField.MatchString(field) || replicateReservedOption(field, mediaField) {
			return "", body, fmt.Errorf("Replicate 高级参数不能覆盖提示词或媒体字段 %q", field)
		}
		switch value := option.(type) {
		case string:
			if strings.Contains(value, "://") || strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "data:") {
				return "", body, fmt.Errorf("Replicate 高级参数 %q 不能传入媒体地址", field)
			}
		case bool, json.Number, float64, int:
		default:
			return "", body, fmt.Errorf("Replicate 高级参数 %q 需要字符串、数字或布尔值", field)
		}
		body.Input[field] = option
	}
	if profile.Duration < 0 {
		return "", body, errors.New("Replicate 时长不能为负数")
	}
	if profile.Duration != 0 {
		body.Input["duration"] = profile.Duration
	}
	if profile.AspectRatio != "" {
		body.Input["aspect_ratio"] = profile.AspectRatio
	}
	if name == "google/veo-3.1" && mode == "r2v" {
		if len(input.References) > 3 || profile.Duration != 0 && profile.Duration != 8 ||
			profile.AspectRatio != "" && profile.AspectRatio != "16:9" {
			return "", body, errors.New("Veo 3.1 参考生视频需要 1–3 张图片、8 秒和 16:9")
		}
	}
	prompt := input.Prompt
	switch name {
	case "kwaivgi/kling-v3-omni-video":
		prompt = klingImageToken.ReplaceAllString(prompt, "<<<image_${2}>>>")
		if len(input.References) > 7 || profile.Duration != 0 && (profile.Duration < 3 || profile.Duration > 15) {
			return "", body, errors.New("Kling 3.0 Omni 接受至多 7 张参考图片，时长为 3–15 秒")
		}
	case "minimax/hailuo-2.3":
		if mode == "r2v" || profile.AspectRatio != "" || profile.Duration != 0 && profile.Duration != 6 && profile.Duration != 10 ||
			profile.Duration == 10 && profile.Options["resolution"] == "1080p" {
			return "", body, errors.New("Hailuo 2.3 支持 T2V/I2V，时长 6 秒或 10 秒，10 秒仅支持 768p，比例留空")
		}
	}
	body.Input["prompt"] = prompt
	return endpoint, body, nil
}

func replicateReservedOption(field, mediaField string) bool {
	field = strings.ToLower(field)
	if strings.EqualFold(field, mediaField) {
		return true
	}
	switch field {
	case "duration", "aspect_ratio", "text", "caption", "first_frame", "last_frame", "end_frame", "start_frame", "first_clip":
		return true
	case "generate_audio", "enable_prompt_expansion", "image_size":
		return false
	}
	for _, reserved := range []string{"prompt", "image", "video", "audio", "reference", "url", "file"} {
		if strings.Contains(field, reserved) {
			return true
		}
	}
	return false
}

func (p *replicateProvider) Validate(input GenerationInput) error {
	_, _, err := replicateRequest(p.profile, input)
	return err
}

func (p *replicateProvider) Verify(ctx context.Context) error {
	var account struct {
		Username string `json:"username"`
	}
	_, err := p.request(ctx, http.MethodGet, "/account", "", nil, &account)
	if err == nil && account.Username == "" {
		return errors.New("Replicate 未返回有效的账户信息")
	}
	return err
}

func (p *replicateProvider) Submit(ctx context.Context, input GenerationInput) (ProviderSubmission, error) {
	endpoint, body, err := replicateRequest(p.profile, input)
	if err != nil {
		return ProviderSubmission{Rejected: true}, err
	}
	if len(input.References) != 0 {
		references := make([]string, 0, len(input.References))
		for _, ref := range input.References {
			assetURL, err := p.replicateMedia(ctx, input, ref)
			if err != nil {
				// No prediction request was sent.
				return ProviderSubmission{Rejected: true}, err
			}
			references = append(references, assetURL)
		}
		if p.profile.Mode == "i2v" {
			body.Input[p.profile.InputField] = references[0]
		} else {
			body.Input[p.profile.InputField] = references
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return ProviderSubmission{Rejected: true}, err
	}
	var prediction replicatePrediction
	code, err := p.request(ctx, http.MethodPost, endpoint, "application/json", bytes.NewReader(payload), &prediction)
	if err != nil {
		return ProviderSubmission{Rejected: replicateRejected(code)}, err
	}
	if !replicateIdentifier.MatchString(prediction.ID) {
		return ProviderSubmission{}, errors.New("Replicate 未返回有效的预测 ID")
	}
	return ProviderSubmission{TaskID: prediction.ID}, nil
}

func replicateRejected(code int) bool {
	switch code {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden,
		http.StatusNotFound, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity, http.StatusTooManyRequests:
		return true
	default:
		return false
	}
}

func (p *replicateProvider) Poll(ctx context.Context, id string) (ProviderResult, error) {
	if !replicateIdentifier.MatchString(id) {
		return ProviderResult{}, permanentProviderError("Replicate 预测 ID 无效")
	}
	var prediction replicatePrediction
	if _, err := p.request(ctx, http.MethodGet, "/predictions/"+id, "", nil, &prediction); err != nil {
		return ProviderResult{}, err
	}
	if prediction.ID != id {
		return ProviderResult{}, permanentProviderError("Replicate 返回了不匹配的预测 ID")
	}
	switch prediction.Status {
	case "starting":
		return ProviderResult{Status: "pending"}, nil
	case "processing":
		return ProviderResult{Status: "running"}, nil
	case "canceled":
		return ProviderResult{Status: "cancelled"}, nil
	case "failed":
		var message string
		_ = json.Unmarshal(prediction.Error, &message)
		return ProviderResult{Status: "failed", Error: (videoHTTP{key: p.apiKey}).safeMessage(message)}, nil
	case "succeeded":
		asset, extension := replicateOutput(prediction.Output, p.profile.Mode == "t2i")
		if asset == "" {
			return ProviderResult{Status: "failed", Error: "Replicate 生成完成但未返回可下载的视频或图片"}, nil
		}
		return ProviderResult{Status: "succeeded", URL: asset, Extension: extension}, nil
	default:
		return ProviderResult{}, permanentProviderError("Replicate 返回了未知预测状态")
	}
}

func replicateOutput(raw json.RawMessage, image bool) (string, string) {
	var single string
	var outputs []string
	if json.Unmarshal(raw, &single) == nil && single != "" {
		outputs = []string{single}
	} else if json.Unmarshal(raw, &outputs) != nil {
		return "", ""
	}
	for _, output := range outputs {
		parsed, err := url.Parse(output)
		if err != nil || !replicateDelivery(parsed) {
			continue
		}
		extension := strings.ToLower(path.Ext(parsed.Path))
		switch extension {
		case ".png", ".jpg", ".jpeg", ".webp":
			if image {
				return output, extension
			}
		case ".mp4", ".mov", ".webm":
			if !image {
				return output, extension
			}
		}
	}
	return "", ""
}

func replicateDelivery(address *url.URL) bool {
	host := strings.ToLower(address.Hostname())
	return address.Scheme == "https" && address.User == nil && (address.Port() == "" || address.Port() == "443") &&
		(host == "replicate.delivery" || strings.HasSuffix(host, ".replicate.delivery"))
}

func (p *replicateProvider) Download(ctx context.Context, result ProviderResult, writer io.Writer) error {
	parsed, err := url.Parse(result.URL)
	if err != nil || !replicateDelivery(parsed) {
		return errors.New("Replicate 下载地址不属于官方文件服务")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, result.URL, nil)
	if err != nil {
		return errors.New("Replicate 下载地址无效")
	}
	request.Header.Set("Authorization", "Bearer "+p.apiKey)
	response, err := p.download.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Replicate 文件服务返回 HTTP %d", response.StatusCode)
	}
	if header := response.Header.Get("Content-Type"); header != "" {
		mediaType, _, err := mime.ParseMediaType(header)
		if err != nil || mediaType != "application/octet-stream" && mediaType != "binary/octet-stream" &&
			!strings.HasPrefix(mediaType, "video/") && !strings.HasPrefix(mediaType, "image/") {
			return errors.New("Replicate 文件服务未返回媒体文件")
		}
	}
	_, err = io.Copy(writer, response.Body)
	return err
}

func (p *replicateProvider) replicateMedia(ctx context.Context, input GenerationInput, ref GenerationReference) (string, error) {
	if ref.URL != "" {
		return ref.URL, nil
	}
	limit := int64(replicateImageLimit)
	if strings.SplitN(p.profile.Model, ":", 2)[0] == "kwaivgi/kling-v3-omni-video" {
		limit = 10_000_000
	}
	file, mediaType, err := openImageReference(input, ref, limit)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if limit == 10_000_000 && mediaType != "image/png" && mediaType != "image/jpeg" {
		return "", errors.New("Kling 3.0 Omni 图片需要 PNG 或 JPEG")
	}
	extension := map[string]string{
		"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp",
	}[mediaType]
	if extension == "" {
		return "", errors.New("Replicate 本地图片格式不受支持")
	}
	var content bytes.Buffer
	form := multipart.NewWriter(&content)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{
		"name": "content", "filename": "reference" + extension,
	}))
	header.Set("Content-Type", mediaType)
	part, err := form.CreatePart(header)
	if err != nil {
		return "", err
	}
	size, err := io.Copy(part, io.LimitReader(file, replicateImageLimit+1))
	if err != nil {
		return "", err
	}
	if size > replicateImageLimit {
		return "", errors.New("Replicate 本地参考图片超过 20 MiB")
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	var uploaded struct {
		URLs struct {
			Get string `json:"get"`
		} `json:"urls"`
	}
	if _, err := p.request(ctx, http.MethodPost, "/files", form.FormDataContentType(), &content, &uploaded); err != nil {
		return "", err
	}
	asset, err := url.Parse(uploaded.URLs.Get)
	if err != nil || (asset.Scheme != "https" || asset.User != nil || asset.Host != "api.replicate.com") &&
		!replicateDelivery(asset) {
		return "", errors.New("Replicate 文件上传未返回有效的媒体地址")
	}
	return uploaded.URLs.Get, nil
}

func (p *replicateProvider) request(ctx context.Context, method, endpoint, contentType string, body io.Reader, output any) (int, error) {
	if p.apiKey == "" {
		return http.StatusUnauthorized, errors.New("Replicate API Token 未配置")
	}
	request, err := http.NewRequestWithContext(ctx, method, replicateAPI+endpoint, body)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Authorization", "Bearer "+p.apiKey)
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := p.api.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	code := response.StatusCode
	if code < http.StatusOK || code >= http.StatusMultipleChoices {
		var data map[string]any
		_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&data)
		message := providerMessage(data)
		if message == "" {
			message, _ = data["detail"].(string)
		}
		return code, (videoHTTP{key: p.apiKey}).responseError(code, message)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output); err != nil {
		return code, errors.New("无法读取 Replicate API 响应")
	}
	return code, nil
}
