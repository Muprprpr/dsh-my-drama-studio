package studio

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

const videoModelCatalogMessage = "模型列表只验证模型可见性，生成需要实际提交任务"

type videoProvider struct {
	videoHTTP
	profile ProviderProfile
}

func newVideoProvider(profile ProviderProfile, key string, client *http.Client) Provider {
	if profile.Channel == nil {
		return nil
	}
	return &videoProvider{newVideoHTTP(*profile.Channel, key, client), profile}
}

func videoChannelModes(channel VideoChannel) []string {
	switch channel.Protocol {
	case "ark", "byteplus", "minimax-h3":
		return []string{"t2v", "i2v", "r2v"}
	case "replicate":
		return []string{"t2i", "t2v", "i2v", "r2v"}
	case "openai-video":
		return []string{"t2v", "i2v"}
	case "new-api":
		switch channel.TaskPlugin {
		case "xai":
			return []string{"t2v", "i2v", "r2v"}
		case "":
			return []string{"t2v", "i2v"}
		default:
			return []string{"t2v"}
		}
	case "custom-rest":
		if channel.Advanced == nil {
			return nil
		}
		modes := []string{"t2v"}
		for _, item := range []struct{ mode, field string }{
			{"i2v", "firstFrame"}, {"r2v", "references"}, {"v2v", "sourceVideo"},
		} {
			if customWritePath(channel.Advanced, item.field) != "" {
				modes = append(modes, item.mode)
			}
		}
		return modes
	default:
		return nil
	}
}

func (p *videoProvider) Validate(input GenerationInput) error {
	if err := validateVideoChannel(p.channel); err != nil {
		return err
	}
	if input.Type != "video" || strings.TrimSpace(input.Prompt) == "" || p.profile.Model == "" {
		return errors.New("视频生成需要模型和完整提示词")
	}
	if !slices.Contains(videoChannelModes(p.channel), input.Mode) {
		return invalidAdapterMode(input.Mode)
	}
	refs := input.References
	kinds := make([]string, len(refs))
	for i, ref := range refs {
		kinds[i] = ref.Type
	}
	if err := validateVideoInputs(input.Mode, kinds); err != nil {
		return err
	}
	if input.Mode == "i2v" && len(refs) == 2 && !p.supportsTailFrame() {
		return errors.New("当前渠道协议不接收尾帧")
	}
	for _, ref := range refs {
		if ref.Path == "" && !providerURL(ref.URL) {
			return errors.New("视频输入需要图片、视频或音频项目素材，或可访问的 HTTP/HTTPS URL")
		}
		if p.channel.Protocol == "new-api" && p.channel.TaskPlugin == "xai" && ref.Type == "video" {
			return errors.New("New API xAI Task 参考生视频只接收图片和音频")
		}
	}
	if usesVideoDimensions(p.channel) {
		_, _, err := videoDimensions(input.Params)
		return err
	}
	return nil
}

func usesVideoDimensions(channel VideoChannel) bool {
	return channel.Protocol == "openai-video" || channel.Protocol == "new-api" && channel.TaskPlugin == ""
}

func (p *videoProvider) supportsTailFrame() bool {
	return p.channel.Protocol == "new-api" && p.channel.TaskPlugin == "xai" ||
		p.channel.Protocol == "custom-rest" && customWritePath(p.channel.Advanced, "lastFrame") != ""
}

func videoParamFields(model string, input GenerationInput) map[string]any {
	params := input.Params
	body := map[string]any{"model": model, "prompt": input.Prompt}
	if params.Duration != 0 {
		body["duration"] = params.Duration
	}
	if params.Resolution != "" {
		body["resolution"] = params.Resolution
	}
	if params.AspectRatio != "" {
		body["aspectRatio"] = params.AspectRatio
	}
	if params.GenerateAudio != nil {
		body["generateAudio"] = *params.GenerateAudio
	}
	return body
}

func videoDimensions(params VideoParams) (int, int, error) {
	resolution := strings.ToLower(params.Resolution)
	if resolution == "" {
		if params.AspectRatio != "" {
			return 0, 0, errors.New("该协议需要分辨率和画幅一起配置，才能确定输出尺寸")
		}
		return 0, 0, nil
	}
	ratioW, ratioH, hasRatio := splitDimensions(params.AspectRatio, ":")
	hasRatio = hasRatio && ratioW <= 99 && ratioH <= 99
	if params.AspectRatio != "" && !hasRatio {
		return 0, 0, errors.New("该协议需要明确的输出画幅，例如 16:9")
	}
	if width, height, ok := splitDimensions(resolution, "x"); ok && width <= 8192 && height <= 8192 {
		if hasRatio && (width*ratioH*100 < height*ratioW*98 || width*ratioH*100 > height*ratioW*102) {
			return 0, 0, errors.New("配置的画幅与分辨率不匹配")
		}
		return width, height, nil
	}
	if pixels, ok := strings.CutSuffix(resolution, "p"); ok {
		short, err := strconv.Atoi(pixels)
		if err == nil && short > 0 && short <= 4320 && hasRatio {
			width, height := short, short
			if ratioW >= ratioH {
				width = (short*ratioW + ratioH) / (2 * ratioH) * 2
			} else {
				height = (short*ratioH + ratioW) / (2 * ratioW) * 2
			}
			if width <= 8192 && height <= 8192 {
				return width, height, nil
			}
		}
	}
	return 0, 0, errors.New("该协议的分辨率需为 WIDTHxHEIGHT，或与明确画幅一起填写，例如 720p 和 16:9")
}

func splitDimensions(raw, separator string) (int, int, bool) {
	x, y, ok := strings.Cut(raw, separator)
	if !ok {
		return 0, 0, false
	}
	w, errW := strconv.Atoi(x)
	h, errH := strconv.Atoi(y)
	return w, h, errW == nil && errH == nil && w > 0 && h > 0
}

func (p *videoProvider) Submit(ctx context.Context, input GenerationInput) (ProviderSubmission, error) {
	if err := p.Validate(input); err != nil {
		return ProviderSubmission{Rejected: true}, err
	}
	if p.key == "" && !p.channel.withoutKey() {
		return ProviderSubmission{Rejected: true}, errors.New("视频渠道没有可用的 API 密钥")
	}
	remaining := int64(32 << 20)
	if p.channel.Protocol == "openai-video" {
		remaining = 15 << 20 // The encoded OpenAI image URL is limited to 20 MiB.
	}
	refs := make([]string, 0, len(input.References))
	for _, ref := range input.References {
		value, err := videoMediaValue(input, ref, &remaining)
		if err != nil {
			return ProviderSubmission{Rejected: true}, err
		}
		refs = append(refs, value)
	}
	method, endpoint, body := p.submitRequest(input, refs)
	response, err := p.json(ctx, method, endpoint, body)
	if err != nil {
		return ProviderSubmission{Rejected: submissionRejected(err)}, err
	}
	id := ""
	switch p.channel.Protocol {
	case "openai-video":
		id = videoTaskID(response["id"])
	case "new-api":
		id = newAPITaskID(response)
	case "custom-rest":
		id = videoTaskID(videoField(response, p.channel.Advanced.TaskIDPath))
	}
	if id != "" {
		return ProviderSubmission{TaskID: id}, nil
	}
	for _, field := range []string{"error.message", "error", "data.error.message"} {
		if message, ok := videoField(response, field).(string); ok && strings.TrimSpace(message) != "" {
			return ProviderSubmission{Rejected: true}, errors.New(p.safeMessage(message))
		}
	}
	return ProviderSubmission{}, errors.New("Video API did not return a valid task ID")
}

func (p *videoProvider) submitRequest(input GenerationInput, refs []string) (string, string, map[string]any) {
	body := map[string]any{"model": p.profile.Model, "prompt": input.Prompt}
	params := input.Params
	switch p.channel.Protocol {
	case "custom-rest":
		a := p.channel.Advanced
		endpoint, _ := p.configuredEndpoint(a.SubmitURL, "", "")
		return a.SubmitMethod, endpoint, p.customPayload(input, refs)
	case "openai-video":
		if params.Duration > 0 {
			body["seconds"] = strconv.Itoa(params.Duration)
		}
		if width, height, _ := videoDimensions(params); width > 0 {
			body["size"] = fmt.Sprintf("%dx%d", width, height)
		}
		if input.Mode == "i2v" {
			body["input_reference"] = map[string]string{"image_url": refs[0]}
		}
		return http.MethodPost, p.v1("videos"), body
	case "new-api":
		switch p.channel.TaskPlugin {
		case "":
			if params.Duration > 0 {
				body["duration"] = params.Duration
			}
			if width, height, _ := videoDimensions(params); width > 0 {
				body["width"], body["height"] = width, height
			}
			if input.Mode == "i2v" {
				body["image"] = refs[0]
			}
			return http.MethodPost, p.v1("video/generations"), body
		case "xai":
			fillXAITaskFields(body, input, refs)
		}
		return http.MethodPost, p.v1("tasks/" + p.channel.TaskPlugin), body
	}
	return "", "", body
}

func fillXAITaskFields(body map[string]any, input GenerationInput, refs []string) {
	params := input.Params
	if params.Duration > 0 {
		body["duration"] = params.Duration
	}
	if params.Resolution != "" {
		body["resolution"] = params.Resolution
	}
	if params.AspectRatio != "" {
		body["aspect_ratio"] = params.AspectRatio
	}
	if params.GenerateAudio != nil {
		body["generate_audio"] = *params.GenerateAudio
	}
	switch input.Mode {
	case "i2v":
		body["image"] = refs[0]
		if len(refs) == 2 {
			body["last_frame"] = refs[1]
		}
	case "r2v":
		var images []string
		var audio []map[string]string
		for i, ref := range input.References {
			switch ref.Type {
			case "image":
				images = append(images, refs[i])
			case "audio":
				audio = append(audio, map[string]string{"url": refs[i]})
			}
		}
		if len(images) != 0 {
			body["reference_images"] = images
		}
		if len(audio) != 0 {
			body["reference_audios"] = audio
		}
	}
}

func newAPITaskID(response map[string]any) string {
	for _, field := range []string{"task_id", "id", "data.task_id", "data.id"} {
		if id := videoTaskID(videoField(response, field)); id != "" {
			return id
		}
	}
	return ""
}

func (p *videoProvider) Poll(ctx context.Context, id string) (ProviderResult, error) {
	if videoTaskID(id) == "" {
		return ProviderResult{}, permanentProviderError("Invalid video task ID")
	}
	method, endpoint := p.pollRequest(id)
	response, err := p.json(ctx, method, endpoint, nil)
	if err != nil {
		return ProviderResult{}, err
	}
	responseID, state, rawURL, format := p.readTask(response)
	if responseID != "" && responseID != id {
		return ProviderResult{}, permanentProviderError("Video API returned a different task ID")
	}
	switch state {
	case "pending", "running", "failed", "cancelled":
		message := ""
		if state == "failed" || state == "cancelled" {
			message = p.safeMessage(providerMessage(response))
		}
		return ProviderResult{Status: state, Error: message}, nil
	case "succeeded":
		return p.completedTask(ctx, id, rawURL, format)
	default:
		message := p.safeMessage(providerMessage(response))
		if message == "" {
			message = "Video API returned an unmapped task status"
		}
		return ProviderResult{}, permanentProviderError(message)
	}
}

func (p *videoProvider) pollRequest(id string) (string, string) {
	escaped := url.PathEscape(id)
	switch p.channel.Protocol {
	case "openai-video":
		return http.MethodGet, p.v1("videos/" + escaped)
	case "new-api":
		if p.channel.TaskPlugin != "" {
			return http.MethodGet, p.v1("tasks/" + escaped)
		}
		return http.MethodGet, p.v1("video/generations/" + escaped)
	case "custom-rest":
		a := p.channel.Advanced
		endpoint, _ := p.configuredEndpoint(a.QueryURL, "{taskId}", id)
		if a.QueryMethod != "" {
			return a.QueryMethod, endpoint
		}
		return http.MethodGet, endpoint
	}
	return "", ""
}

func (p *videoProvider) readTask(response map[string]any) (id, state, output, format string) {
	switch p.channel.Protocol {
	case "custom-rest":
		a := p.channel.Advanced
		id = videoTaskID(videoField(response, a.TaskIDPath))
		status := videoScalar(videoField(response, a.StatusPath))
		output, _ = videoField(response, a.OutputURLPath).(string)
		return id, videoProviderStatus(a.StatusMap[status]), output, ""
	case "openai-video":
		return videoTaskID(response["id"]), videoProviderStatus(videoScalar(response["status"])), "", ""
	case "new-api":
		id = newAPITaskID(response)
		task := response
		if data, ok := response["data"].(map[string]any); ok && data["status"] != nil {
			task = data
		}
		output, _ = task["result_url"].(string)
		if output == "" {
			output, _ = task["url"].(string)
		}
		format, _ = task["format"].(string)
		return id, videoProviderStatus(videoScalar(task["status"])), output, format
	}
	return "", "", "", ""
}

func videoProviderStatus(value string) string {
	switch strings.ToLower(value) {
	case "queued", "not_start", "submitted", "pending":
		return "pending"
	case "processing", "in_progress", "running":
		return "running"
	case "completed", "success", "succeeded":
		return "succeeded"
	case "failed", "failure":
		return "failed"
	case "cancelled", "canceled":
		return "cancelled"
	default:
		return ""
	}
}

func (p *videoProvider) completedTask(ctx context.Context, id, rawURL, format string) (ProviderResult, error) {
	switch {
	case p.channel.Protocol == "custom-rest" && p.channel.Advanced.DownloadURL != "":
		var err error
		rawURL, err = p.configuredEndpoint(p.channel.Advanced.DownloadURL, "{taskId}", id)
		if err != nil {
			return ProviderResult{}, permanentProviderError(err.Error())
		}
	case p.channel.Protocol == "openai-video":
		rawURL = p.v1("videos/" + url.PathEscape(id) + "/content")
	case p.channel.Protocol == "new-api" && p.channel.TaskPlugin != "":
		var err error
		rawURL, format, err = p.newAPIArtifact(ctx, id)
		if err != nil {
			return ProviderResult{}, err
		}
	case p.channel.Protocol == "new-api" && rawURL == "":
		rawURL = p.v1("videos/" + url.PathEscape(id) + "/content")
	}
	output, err := p.outputURL(rawURL)
	if err != nil {
		return ProviderResult{}, err
	}
	return ProviderResult{Status: "succeeded", URL: output, Extension: providerOutputExtension(output, format)}, nil
}

func (p *videoProvider) newAPIArtifact(ctx context.Context, id string) (string, string, error) {
	endpoint := p.v1("tasks/" + url.PathEscape(id) + "/artifacts")
	body, err := p.json(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", err
	}
	artifacts, _ := body["artifacts"].([]any)
	for _, artifact := range artifacts {
		key := videoTaskID(videoField(artifact, "key"))
		kind, _ := videoField(artifact, "type").(string)
		mime, _ := videoField(artifact, "mime_type").(string)
		if key != "" && (kind == "video" || strings.HasPrefix(mime, "video/")) {
			return endpoint + "/" + url.PathEscape(key) + "/content", mime, nil
		}
	}
	return "", "", permanentProviderError("New API task completed without a video artifact")
}

func (p *videoProvider) Download(ctx context.Context, result ProviderResult, writer io.Writer) error {
	return p.download(ctx, result, writer)
}

func (p *videoProvider) Probe(ctx context.Context, model string) VideoProbe {
	probe := VideoProbe{Authentication: "unverified", ModelCallable: "unverified", TaskSucceeded: "unverified"}
	if err := validateVideoChannel(p.channel); err != nil {
		probe.Message = err.Error()
		return probe
	}
	probe.ConfigValid = true
	if p.channel.withoutKey() {
		probe.Authentication = "not_required"
	} else if p.key == "" {
		probe.Message = "请先保存渠道密钥"
		return probe
	}
	if p.channel.Protocol == "custom-rest" {
		return p.probeCustom(ctx, model, probe)
	}

	models, err := p.json(ctx, http.MethodGet, p.v1("models"), nil)
	if err != nil {
		return probeError(probe, err)
	}
	list, ok := models["data"].([]any)
	if !ok || models["object"] != "list" {
		probe.Message = "模型接口没有返回有效的模型列表"
		return probe
	}
	if p.challengeConfirmsAuth(ctx, p.v1("models")) {
		probe.Authentication = "verified"
	}
	if model != "" {
		probe.ModelCallable = "not_listed"
		for _, entry := range list {
			if videoField(entry, "id") == model {
				probe.ModelCallable = "listed"
				break
			}
		}
		probe.Message = videoModelCatalogMessage
	}
	return probe
}

func (p *videoProvider) probeCustom(ctx context.Context, model string, probe VideoProbe) VideoProbe {
	a := p.channel.Advanced
	probeURL := a.ProbeURL
	if probeURL == "" && model != "" {
		probeURL = a.ModelProbeURL
	}
	if probeURL != "" {
		endpoint, _ := p.configuredEndpoint(probeURL, "{model}", model)
		response, err := p.request(ctx, http.MethodGet, endpoint, "", nil)
		if err != nil {
			return probeError(probe, err)
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			_, err := p.jsonResponse(response)
			return probeError(probe, err)
		}
		response.Body.Close()
		if !p.channel.withoutKey() && p.challengeConfirmsAuth(ctx, endpoint) {
			probe.Authentication = "verified"
		}
	}
	if model != "" && a.ModelProbeURL != "" {
		endpoint, _ := p.configuredEndpoint(a.ModelProbeURL, "{model}", model)
		info, err := p.json(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return probeError(probe, err)
		}
		if info["id"] == model || videoField(info, "data.id") == model {
			probe.ModelCallable = "listed"
		}
	}
	if probe.Authentication == "unverified" {
		probe.Message = "未获得足以确认鉴权通过的只读响应"
	}
	return probe
}

func (p *videoProvider) challengeConfirmsAuth(ctx context.Context, endpoint string) bool {
	anonymous, err := p.send(ctx, http.MethodGet, endpoint, "", nil, false)
	if err != nil {
		return false
	}
	anonymous.Body.Close()
	return anonymous.StatusCode == http.StatusUnauthorized || anonymous.StatusCode == http.StatusForbidden
}

func probeError(probe VideoProbe, err error) VideoProbe {
	var response *providerRequestError
	if err != nil {
		probe.Message = err.Error()
	}
	if errors.As(err, &response) && (response.status == 401 || response.status == 403) {
		probe.Authentication = "failed"
	}
	return probe
}
