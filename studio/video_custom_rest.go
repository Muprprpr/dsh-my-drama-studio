package studio

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var videoPluginKey = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var videoDotPath = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$`)
var videoWritePath = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$`)
var videoAuthHeader = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)
var videoIdentifier = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,200}$`)

var mappedVideoFields = []string{
	"model", "prompt", "duration", "resolution", "aspectRatio", "generateAudio", "firstFrame", "lastFrame", "references", "sourceVideo",
}

func validateVideoChannel(channel VideoChannel) error {
	if channel.TaskPlugin != "" && (channel.Protocol != "new-api" || !videoPluginKey.MatchString(channel.TaskPlugin)) {
		return invalid("New API Task 插件名称无效")
	}
	if channel.Protocol != "custom-rest" {
		return nil
	}
	a := channel.Advanced
	if a == nil {
		return invalid("Custom REST 需要高级配置")
	}
	if !slices.Contains([]string{http.MethodPost, http.MethodPut, http.MethodPatch}, a.SubmitMethod) ||
		!slices.Contains([]string{"", http.MethodGet, http.MethodPost}, a.QueryMethod) {
		return invalid("Custom REST 提交方法需为 POST/PUT/PATCH，查询方法需为 GET/POST")
	}
	if !slices.Contains([]string{"bearer", "header", "none"}, a.Auth) {
		return invalid("Custom REST 鉴权方式无效")
	}
	if a.Auth == "header" && (!videoAuthHeader.MatchString(a.AuthHeader) ||
		slices.Contains([]string{"host", "cookie", "content-type", "content-length", "proxy-authorization"}, strings.ToLower(a.AuthHeader))) {
		return invalid("Custom REST 自定义鉴权请求头无效")
	}

	httpClient := newVideoHTTP(channel, "", nil)
	for _, item := range []struct {
		raw, token, sample string
		required           bool
	}{
		{raw: a.SubmitURL, required: true},
		{raw: a.QueryURL, token: "{taskId}", sample: "task-1", required: true},
		{raw: a.DownloadURL, token: "{taskId}", sample: "task-1", required: a.DownloadURL != ""},
		{raw: a.ProbeURL},
		{raw: a.ModelProbeURL, token: "{model}", sample: "model-1"},
	} {
		if item.raw == "" && !item.required {
			continue
		}
		if item.token != "" && item.required && !strings.Contains(item.raw, item.token) {
			return invalid("Custom REST 查询和下载 URL 需要包含 {taskId}")
		}
		if _, err := httpClient.configuredEndpoint(item.raw, item.token, item.sample); err != nil {
			return err
		}
	}
	for _, field := range []string{a.TaskIDPath, a.StatusPath} {
		if !validVideoFieldPath(field, false) {
			return invalid("Custom REST 需要有效的任务 ID 和状态字段路径")
		}
	}
	if (a.OutputURLPath == "") == (a.DownloadURL == "") {
		return invalid("Custom REST 需要填写下载地址字段路径或下载 URL，二选一")
	}
	if a.OutputURLPath != "" && !validVideoFieldPath(a.OutputURLPath, false) {
		return invalid("Custom REST 下载地址字段路径无效")
	}
	for key := range a.Fields {
		if !slices.Contains(mappedVideoFields, key) {
			return invalid("Custom REST 不支持请求字段 %s", key)
		}
	}
	paths := make([]string, 0, len(a.Fields)+2)
	for _, canonical := range mappedVideoFields {
		field := customWritePath(a, canonical)
		if field == "" {
			continue
		}
		if !validVideoFieldPath(field, true) {
			return invalid("Custom REST 请求字段 %s 的路径无效", canonical)
		}
		for _, existing := range paths {
			if existing == field || strings.HasPrefix(existing, field+".") || strings.HasPrefix(field, existing+".") {
				return invalid("Custom REST 请求字段路径冲突")
			}
		}
		paths = append(paths, field)
	}

	hasCompletion, hasFailure := false, false
	for remote, local := range a.StatusMap {
		if remote == "" || len(remote) > 120 || !slices.Contains([]string{"queued", "processing", "completed", "failed", "cancelled"}, local) {
			return invalid("Custom REST 状态映射无效")
		}
		hasCompletion = hasCompletion || local == "completed"
		hasFailure = hasFailure || local == "failed"
	}
	if !hasCompletion || !hasFailure {
		return invalid("Custom REST 至少需要填写成功和失败的上游状态")
	}
	return nil
}

func validVideoFieldPath(field string, write bool) bool {
	if len(field) > 240 || strings.Count(field, ".") > 12 {
		return false
	}
	if write {
		return videoWritePath.MatchString(field)
	}
	return videoDotPath.MatchString(field)
}

func customWritePath(a *CustomREST, canonical string) string {
	if value := a.Fields[canonical]; value != "" {
		return value
	}
	if canonical == "model" || canonical == "prompt" {
		return canonical
	}
	return ""
}

func videoField(value any, field string) any {
	if field == "" {
		return nil
	}
	for _, component := range strings.Split(field, ".") {
		switch current := value.(type) {
		case map[string]any:
			value = current[component]
		case []any:
			index, err := strconv.Atoi(component)
			if err != nil || index < 0 || index >= len(current) {
				return nil
			}
			value = current[index]
		default:
			return nil
		}
	}
	return value
}

func setVideoField(body map[string]any, field string, value any) {
	segments := strings.Split(field, ".")
	for _, part := range segments[:len(segments)-1] {
		child, ok := body[part].(map[string]any)
		if !ok {
			child = make(map[string]any)
			body[part] = child
		}
		body = child
	}
	body[segments[len(segments)-1]] = value
}

func videoScalar(value any) string {
	switch val := value.(type) {
	case string:
		return val
	case json.Number:
		return val.String()
	default:
		return ""
	}
}

func videoTaskID(value any) string {
	id := videoScalar(value)
	if !videoIdentifier.MatchString(id) || id == "." || id == ".." {
		return ""
	}
	return id
}

func (p videoHTTP) configuredEndpoint(raw, placeholder, value string) (string, error) {
	if placeholder != "" {
		left, right, hasQuery := strings.Cut(raw, "?")
		raw = strings.ReplaceAll(left, placeholder, url.PathEscape(value))
		if hasQuery {
			raw += "?" + strings.ReplaceAll(right, placeholder, url.QueryEscape(value))
		}
	}
	if raw == "" || len(raw) > 2000 || strings.ContainsAny(raw, "{}\\") || strings.HasPrefix(raw, "//") {
		return "", invalid("Custom REST URL 无效")
	}
	ref, err := url.Parse(raw)
	if err != nil || ref.User != nil || ref.Fragment != "" || ref.Opaque != "" {
		return "", invalid("Custom REST URL 无效")
	}
	query, err := url.ParseQuery(ref.RawQuery)
	if err != nil {
		return "", invalid("Custom REST URL 的查询参数无效")
	}
	for key := range query {
		normalized := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(key))
		if slices.Contains([]string{"apikey", "accesstoken", "authorization", "signature", "token", "secret"}, normalized) {
			return "", invalid("请通过渠道密钥和鉴权设置传递凭据")
		}
	}
	if !ref.IsAbs() {
		raw = p.endpoint(raw)
	}
	if !sameAPIOrigin(p.channel.BaseURL, raw) {
		return "", invalid("Custom REST URL 必须与渠道 Base URL 使用同一来源")
	}
	return raw, nil
}

func (p *videoProvider) customPayload(input GenerationInput, refs []string) map[string]any {
	a := p.channel.Advanced
	body := map[string]any{}
	for field, value := range videoParamFields(p.profile.Model, input) {
		if fieldPath := customWritePath(a, field); fieldPath != "" {
			setVideoField(body, fieldPath, value)
		}
	}
	assign := func(key string, value any) {
		if field := customWritePath(a, key); field != "" {
			setVideoField(body, field, value)
		}
	}
	switch input.Mode {
	case "i2v":
		assign("firstFrame", refs[0])
		if len(refs) == 2 {
			assign("lastFrame", refs[1])
		}
	case "v2v":
		assign("sourceVideo", refs[0])
	case "r2v":
		media := make([]map[string]string, 0, len(refs))
		for i, asset := range refs {
			media = append(media, map[string]string{"type": input.References[i].Type, "url": asset})
		}
		assign("references", media)
	}
	return body
}

func invalidAdapterMode(mode string) error {
	return fmt.Errorf("当前渠道协议不支持 %s", strings.ToUpper(mode))
}
