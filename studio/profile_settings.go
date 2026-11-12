package studio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"

	"github.com/google/uuid"
)

type VideoChannel struct {
	ID         string      `json:"id,omitempty"`
	Name       string      `json:"name"`
	Protocol   string      `json:"protocol"`
	BaseURL    string      `json:"baseUrl,omitempty"`
	TaskPlugin string      `json:"taskPlugin,omitempty"`
	Advanced   *CustomREST `json:"advanced,omitempty"`
}

type CustomREST struct {
	SubmitURL     string            `json:"submitUrl"`
	SubmitMethod  string            `json:"submitMethod"`
	Auth          string            `json:"auth"`
	AuthHeader    string            `json:"authHeader,omitempty"`
	Fields        map[string]string `json:"fields"`
	TaskIDPath    string            `json:"taskIdPath"`
	QueryURL      string            `json:"queryUrl"`
	QueryMethod   string            `json:"queryMethod,omitempty"`
	StatusPath    string            `json:"statusPath"`
	StatusMap     map[string]string `json:"statusMap"`
	OutputURLPath string            `json:"outputUrlPath,omitempty"`
	DownloadURL   string            `json:"downloadUrl,omitempty"`
	ProbeURL      string            `json:"probeUrl,omitempty"`
	ModelProbeURL string            `json:"modelProbeUrl,omitempty"`
}

type VideoParams struct {
	Duration      int    `json:"duration,omitempty"`
	Resolution    string `json:"resolution,omitempty"`
	AspectRatio   string `json:"aspectRatio,omitempty"`
	GenerateAudio *bool  `json:"generateAudio,omitempty"`
}

type VideoLimits struct {
	DurationMin   int            `json:"durationMin,omitempty"`
	DurationMax   int            `json:"durationMax,omitempty"`
	Durations     []int          `json:"durations,omitempty"`
	Resolutions   []string       `json:"resolutions,omitempty"`
	AspectRatios  []string       `json:"aspectRatios,omitempty"`
	GenerateAudio bool           `json:"generateAudio,omitempty"`
	LastFrame     bool           `json:"lastFrame,omitempty"`
	References    map[string]int `json:"references,omitempty"`
	MaxReferences int            `json:"maxReferences,omitempty"`
}

type GenerationSettings struct {
	VideoParams
	DefaultModelID  string `json:"defaultModelId,omitempty"`
	MaxConcurrent   int    `json:"maxConcurrent"`
	OutputDirectory string `json:"outputDirectory"`
}

type VideoProbe struct {
	ConfigValid    bool   `json:"configValid"`
	Authentication string `json:"authentication"`
	ModelCallable  string `json:"modelCallable"`
	TaskSucceeded  string `json:"taskSucceeded"`
	Message        string `json:"message,omitempty"`
}

type channelView struct {
	VideoChannel
	Configured   bool       `json:"configured"`
	Verification VideoProbe `json:"verification,omitzero"`
	Modes        []string   `json:"modes"`
}

func (c VideoChannel) withoutKey() bool {
	return c.Protocol == "custom-rest" && c.Advanced != nil && c.Advanced.Auth == "none"
}

func OpenProfileSettings(legacyPath string) (*ProviderSettings, error) {
	s := &ProviderSettings{
		legacyPath: legacyPath,
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
	s.normalize()
	return s, nil
}

func (s *ProviderSettings) normalize() {
	if s.data.Generation.MaxConcurrent == 0 {
		s.data.Generation.MaxConcurrent = 2
	}
	if s.data.Generation.OutputDirectory == "" {
		s.data.Generation.OutputDirectory = "assets/videos"
	}
	if s.data.Keys == nil {
		s.data.Keys = make(map[string]string)
	}
	if s.data.Defaults == nil {
		s.data.Defaults = make(map[string]string)
	}
	if s.verification == nil {
		s.verification = make(map[string]VideoProbe)
	}
	if s.completed == nil {
		s.completed = make(map[string]map[string]bool)
	}
}

func (s *ProviderSettings) MaxConcurrent() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data.Generation.MaxConcurrent
}

func (s *ProviderSettings) channel(id string) (VideoChannel, bool) {
	for _, channel := range s.data.Channels {
		if channel.ID == id {
			return channel, true
		}
	}
	return VideoChannel{}, false
}

func validateChannel(channel VideoChannel) error {
	if len(channel.Name) == 0 || len(channel.Name) > 160 {
		return invalid("需要有效的渠道名称")
	}
	if slices.Contains(providerNames, channel.Protocol) || channel.Protocol == minimaxH3Protocol {
		if channel.BaseURL != "" || channel.Advanced != nil || channel.TaskPlugin != "" {
			return invalid("内置渠道使用固定接口")
		}
		return nil
	}
	if !slices.Contains([]string{"new-api", "openai-video", "custom-rest"}, channel.Protocol) {
		return invalid("请选择支持的渠道协议")
	}
	base, err := url.Parse(channel.BaseURL)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Hostname() == "" ||
		base.User != nil || base.RawQuery != "" || base.Fragment != "" || len(channel.BaseURL) > 500 {
		return invalid("Base URL 需要完整的 HTTP/HTTPS 地址，不含认证信息、查询参数或片段")
	}
	if channel.Protocol == "custom-rest" && channel.Advanced == nil || channel.Protocol != "custom-rest" && channel.Advanced != nil {
		return invalid("Custom REST 需要高级配置")
	}
	if err := validateVideoChannel(channel); err != nil {
		return invalid("%s", err)
	}
	return nil
}

func validateGeneration(g GenerationSettings) error {
	if g.MaxConcurrent < 1 || g.MaxConcurrent > 32 {
		return invalid("最大并发数须为 1–32")
	}
	if err := validateOutputDirectory(g.OutputDirectory); err != nil {
		return err
	}
	return validateVideoParams(g.VideoParams)
}

func validateOutputDirectory(directory string) error {
	if !filepath.IsLocal(directory) || filepath.ToSlash(filepath.Clean(directory)) != directory ||
		!strings.HasPrefix(directory, "assets/") || strings.ContainsAny(directory, "\\:") {
		return invalid("结果保存目录必须是项目 assets/ 下的相对路径")
	}
	return nil
}

func validateVideoParams(p VideoParams) error {
	if p.Duration < -1 || p.Duration > 3600 || (p.AspectRatio != "" && !ratioName.MatchString(p.AspectRatio)) ||
		len(p.Resolution) > 32 || strings.ContainsAny(p.Resolution, "\r\n\t /\\") {
		return invalid("时长、分辨率或画幅格式无效")
	}
	return nil
}

func validateModel(p ProviderProfile, c VideoChannel) error {
	if p.Name == "" || len(p.Name) > 160 || !profileModel.MatchString(p.Model) || strings.Contains(p.Model, "..") ||
		len(p.Modes) == 0 || len(p.Modes) > 5 {
		return invalid("需要有效的预设名称、模型 ID 和生成方式")
	}
	if p.ArkFamily != "" && c.Protocol != "ark" && c.Protocol != "byteplus" {
		return invalid("只有方舟和 BytePlus 预设可指定部署模型系列")
	}
	seen := map[string]bool{}
	supported := videoChannelModes(c)
	for _, mode := range p.Modes {
		if !slices.Contains([]string{"t2i", "t2v", "i2v", "r2v", "v2v"}, mode) || seen[mode] ||
			mode == "t2i" && (c.Protocol != "replicate" || len(p.Modes) > 1) {
			return invalid("预设包含无效或重复的生成方式")
		}
		if !slices.Contains(supported, mode) {
			return invalid("所选渠道协议不支持 %s", strings.ToUpper(mode))
		}
		seen[mode] = true
		if slices.Contains(providerNames, c.Protocol) {
			legacy := p
			legacy.Mode, legacy.Provider = mode, c.Protocol
			legacy.Duration, legacy.AspectRatio = p.Defaults.Duration, p.Defaults.AspectRatio
			if err := validateProfile(legacy); err != nil {
				return err
			}
		}
	}
	if c.Protocol == minimaxH3Protocol {
		if err := validateMinimaxModel(p); err != nil {
			return invalid("%s", err)
		}
	}
	if !slices.Contains(providerNames, c.Protocol) && (len(p.Options) != 0 || p.InputField != "") {
		return invalid("该渠道的参数由协议和模型能力配置")
	}
	if err := validateProtocolCapabilities(p, c); err != nil {
		return err
	}
	l := p.Limits
	if l.DurationMin < 0 || l.DurationMax < l.DurationMin && l.DurationMax != 0 || l.DurationMax > 3600 ||
		l.MaxReferences < 0 || l.MaxReferences > 32 {
		return invalid("模型参数范围无效")
	}
	for _, duration := range l.Durations {
		if duration < 1 || duration > 3600 {
			return invalid("模型允许的时长无效")
		}
	}
	for _, resolution := range l.Resolutions {
		if resolution == "" || validateVideoParams(VideoParams{Resolution: resolution}) != nil {
			return invalid("模型允许的分辨率无效")
		}
	}
	for _, ratio := range l.AspectRatios {
		if !ratioName.MatchString(ratio) {
			return invalid("模型允许的画幅无效")
		}
	}
	for kind, limit := range l.References {
		if !slices.Contains([]string{"image", "video", "audio"}, kind) || limit < 0 || limit > 32 {
			return invalid("参考素材类型或数量无效")
		}
	}
	if err := validateVideoParams(p.Defaults); err != nil {
		return err
	}
	if usesVideoDimensions(c) && p.Defaults.Resolution != "" && p.Defaults.AspectRatio != "" {
		if _, _, err := videoDimensions(p.Defaults); err != nil {
			return invalid("%s", err)
		}
	}
	p.Channel = &c
	_, err := resolveVideoParams(p, VideoParams{}, p.Defaults)
	return err
}

func validateProtocolCapabilities(p ProviderProfile, c VideoChannel) error {
	if c.Protocol == minimaxH3Protocol {
		return nil
	}
	xai := c.Protocol == "new-api" && c.TaskPlugin == "xai"
	tailFrame, audio := xai, xai
	switch c.Protocol {
	case "custom-rest":
		tailFrame = customWritePath(c.Advanced, "lastFrame") != ""
		audio = customWritePath(c.Advanced, "generateAudio") != ""
	case "ark", "byteplus", "replicate":
		audio = true
	}
	if p.Limits.LastFrame && !tailFrame {
		return invalid("所选渠道协议未定义尾帧输入")
	}
	if (p.Limits.GenerateAudio || p.Defaults.GenerateAudio != nil) && !audio {
		return invalid("所选渠道协议未定义音频生成开关")
	}
	if xai && p.Limits.References["video"] > 0 ||
		slices.Contains(providerNames, c.Protocol) && (p.Limits.References["video"] > 0 || p.Limits.References["audio"] > 0) {
		return invalid("所选渠道协议不接收这些参考素材类型")
	}
	return nil
}

func (s *ProviderSettings) prepareChannel(input *GenerationInput, id string) error {
	selected := slices.IndexFunc(s.data.Profiles, func(p ProviderProfile) bool { return p.ID == id })
	if id == "" {
		preferred := s.data.Generation.DefaultModelID
		if input.Mode == "t2i" || preferred == "" {
			preferred = s.data.Defaults[input.Mode]
		}
		for i, p := range s.data.Profiles {
			c, ok := s.channel(p.ChannelID)
			if !ok || !slices.Contains(p.Modes, input.Mode) || (!c.withoutKey() && s.data.Keys[c.ID] == "") {
				continue
			}
			if p.ID == preferred {
				selected = i
				break
			}
			if selected == -1 {
				selected = i
			} else {
				selected = -2
			}
		}
	}
	if selected == -2 {
		return invalid("请选择生成模型")
	}
	if selected < 0 {
		if id != "" {
			return invalid("所选预设不存在")
		}
		return providerUnavailable
	}
	profile := s.data.Profiles[selected]
	if !slices.Contains(profile.Modes, input.Mode) {
		return invalid("所选模型不支持 %s", strings.ToUpper(input.Mode))
	}
	channel, ok := s.channel(profile.ChannelID)
	if !ok || !channel.withoutKey() && s.data.Keys[channel.ID] == "" {
		return providerUnavailable
	}
	profile.Mode, profile.Provider, profile.Channel = input.Mode, channel.Protocol, &channel
	profile.Duration, profile.AspectRatio = profile.Defaults.Duration, profile.Defaults.AspectRatio
	if input.Type == "video" {
		if err := prepareVideoGeneration(input, &profile, s.data.Generation.VideoParams); err != nil {
			return err
		}
	}
	input.Profile, input.OutputDirectory = profile, s.data.Generation.OutputDirectory
	provider := s.adapter(profile, s.data.Keys[channel.ID])
	if provider == nil {
		return providerUnavailable
	}
	if validator, ok := provider.(interface{ Validate(GenerationInput) error }); ok {
		if err := validator.Validate(*input); err != nil {
			return invalid("%s", err)
		}
	}
	return nil
}

type settingsPlan struct {
	Config    providerData `json:"config"`
	ChannelID string       `json:"channelId,omitempty"`
}

func (s *ProviderSettings) executeProfileSettings(ctx context.Context, action string, raw json.RawMessage) (any, error) {
	switch action {
	case "provider_configure":
		var args struct {
			Config providerData      `json:"config"`
			Keys   map[string]string `json:"keys"`
		}
		if err := decodeData(raw, &args); err != nil {
			return nil, err
		}
		if len(args.Config.Keys) != 0 {
			return nil, invalid("密钥须通过 DSH 凭据服务保存")
		}
		s.mu.Lock()
		for _, previous := range s.data.Channels {
			id := previous.ID
			current, exists := findChannel(args.Config.Channels, id)
			if !exists || !sameChannel(previous, current) || s.data.Keys[id] != args.Keys[id] {
				delete(s.verification, id)
				delete(s.completed, id)
			}
		}
		s.data = args.Config
		s.data.Keys = args.Keys
		s.normalize()
		s.mu.Unlock()
		return s.view(), nil
	case "provider_legacy":
		if s.legacyPath == "" {
			return nil, nil
		}
		legacy, err := readLegacyProviderSettings(s.legacyPath)
		if err != nil || len(legacy.Profiles) == 0 {
			return nil, err
		}
		return importableSettings(legacy), nil
	case "provider_plan":
		var args struct {
			Config providerData    `json:"config"`
			Action string          `json:"action"`
			Data   json.RawMessage `json:"data"`
		}
		if err := decodeData(raw, &args); err != nil {
			return nil, err
		}
		draft := &ProviderSettings{data: args.Config}
		draft.data.Keys = nil
		draft.normalize()
		return draft.plan(args.Action, args.Data)
	case "channel_test":
		return s.testChannel(ctx, raw)
	}
	return nil, invalid("未知设置操作")
}

func sameChannel(a, b VideoChannel) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

func importableSettings(next providerData) map[string]any {
	next.Profiles = slices.Clone(next.Profiles)
	keys := next.Keys
	next.Keys = nil
	for i, p := range next.Profiles {
		if _, ok := findChannel(next.Channels, p.Provider); !ok {
			next.Channels = append(next.Channels, VideoChannel{ID: p.Provider, Name: p.Provider, Protocol: p.Provider})
		}
		p.ChannelID, p.Modes = p.Provider, []string{p.Mode}
		p.Defaults = VideoParams{Duration: p.Duration, AspectRatio: p.AspectRatio}
		next.Profiles[i] = p
	}
	return map[string]any{"config": next, "keys": keys}
}

func findChannel(channels []VideoChannel, id string) (VideoChannel, bool) {
	at := slices.IndexFunc(channels, func(c VideoChannel) bool { return c.ID == id })
	if at < 0 {
		return VideoChannel{}, false
	}
	return channels[at], true
}

func (s *ProviderSettings) plan(action string, raw json.RawMessage) (settingsPlan, error) {
	next := s.data
	next.Keys = nil
	var keyID string
	switch action {
	case "channel_save":
		var args struct {
			Channel VideoChannel `json:"channel"`
		}
		if err := decodeData(raw, &args); err != nil {
			return settingsPlan{}, err
		}
		c := args.Channel
		c.Name, c.BaseURL = strings.TrimSpace(c.Name), strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
		if err := validateChannel(c); err != nil {
			return settingsPlan{}, err
		}
		if c.ID == "" {
			if len(next.Channels) >= 64 {
				return settingsPlan{}, invalid("最多保存 64 个渠道")
			}
			c.ID = uuid.NewString()
			next.Channels = append(next.Channels, c)
		} else {
			i := slices.IndexFunc(next.Channels, func(old VideoChannel) bool { return old.ID == c.ID })
			if i < 0 {
				return settingsPlan{}, invalid("渠道不存在")
			}
			old := next.Channels[i]
			if old.Protocol != c.Protocol || !sameAPIOrigin(old.BaseURL, c.BaseURL) {
				return settingsPlan{}, invalid("更换协议或服务源站时请新建渠道")
			}
			for _, profile := range next.Profiles {
				if profile.ChannelID == c.ID {
					if err := validateModel(profile, c); err != nil {
						return settingsPlan{}, invalid("渠道变更与模型预设 %s 不兼容：%s", profile.Name, err)
					}
				}
			}
			next.Channels[i] = c
		}
		keyID = c.ID
	case "channel_remove", "provider_remove":
		var args struct {
			ID string `json:"id"`
		}
		if err := decodeData(raw, &args); err != nil {
			return settingsPlan{}, err
		}
		if action == "channel_remove" {
			i := slices.IndexFunc(next.Channels, func(c VideoChannel) bool { return c.ID == args.ID })
			if i < 0 {
				return settingsPlan{}, invalid("渠道不存在")
			}
			if slices.ContainsFunc(next.Profiles, func(p ProviderProfile) bool { return p.ChannelID == args.ID }) {
				return settingsPlan{}, invalid("请先移除或迁移该渠道绑定的模型")
			}
			next.Channels = slices.Delete(next.Channels, i, i+1)
			next.Retired = append(next.Retired, args.ID)
		} else {
			i := slices.IndexFunc(next.Profiles, func(p ProviderProfile) bool { return p.ID == args.ID })
			if i < 0 {
				return settingsPlan{}, invalid("模型预设不存在")
			}
			next.Profiles = slices.Delete(next.Profiles, i, i+1)
			if next.Generation.DefaultModelID == args.ID {
				next.Generation.DefaultModelID = ""
			}
			for mode, id := range next.Defaults {
				if id == args.ID {
					delete(next.Defaults, mode)
				}
			}
		}
	case "provider_save":
		var args struct {
			Profile ProviderProfile `json:"profile"`
		}
		if err := decodeData(raw, &args); err != nil {
			return settingsPlan{}, err
		}
		p := args.Profile
		p.Name, p.Model, p.InputField = strings.TrimSpace(p.Name), strings.TrimSpace(p.Model), strings.TrimSpace(p.InputField)
		p.Channel, p.Mode, p.Duration, p.AspectRatio = nil, "", 0, ""
		c, ok := s.channel(p.ChannelID)
		if !ok {
			return settingsPlan{}, invalid("请选择已保存的渠道")
		}
		p.Provider = c.Protocol
		if err := validateModel(p, c); err != nil {
			return settingsPlan{}, err
		}
		if p.ID == "" {
			if len(next.Profiles) >= 128 {
				return settingsPlan{}, invalid("最多保存 128 个模型预设")
			}
			p.ID = uuid.NewString()
			next.Profiles = append(next.Profiles, p)
		} else {
			i := slices.IndexFunc(next.Profiles, func(old ProviderProfile) bool { return old.ID == p.ID })
			if i < 0 {
				return settingsPlan{}, invalid("模型预设不存在")
			}
			next.Profiles[i] = p
		}
	case "generation_save":
		var args struct {
			Generation GenerationSettings `json:"generation"`
		}
		if err := decodeData(raw, &args); err != nil {
			return settingsPlan{}, err
		}
		g := args.Generation
		g.OutputDirectory = strings.TrimSpace(g.OutputDirectory)
		if err := validateGeneration(g); err != nil {
			return settingsPlan{}, err
		}
		if g.DefaultModelID != "" && !slices.ContainsFunc(next.Profiles, func(p ProviderProfile) bool {
			return p.ID == g.DefaultModelID && !slices.Contains(p.Modes, "t2i")
		}) {
			return settingsPlan{}, invalid("默认视频模型不存在")
		}
		next.Generation = g
	default:
		return settingsPlan{}, invalid("未知设置操作")
	}
	return settingsPlan{Config: next, ChannelID: keyID}, nil
}

func sameAPIOrigin(before, after string) bool {
	a, aErr := url.Parse(before)
	b, bErr := url.Parse(after)
	return aErr == nil && bErr == nil && a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host)
}

func (s *ProviderSettings) testChannel(ctx context.Context, raw json.RawMessage) (VideoProbe, error) {
	var args struct {
		ID      string `json:"id"`
		ModelID string `json:"modelId,omitempty"`
	}
	if err := decodeData(raw, &args); err != nil {
		return VideoProbe{}, err
	}
	s.mu.RLock()
	channel, exists := s.channel(args.ID)
	key := s.data.Keys[args.ID]
	model := ""
	if args.ModelID != "" {
		for _, p := range s.data.Profiles {
			if p.ID == args.ModelID && p.ChannelID == args.ID {
				model = p.Model
			}
		}
	}
	s.mu.RUnlock()
	if !exists || args.ModelID != "" && model == "" {
		return VideoProbe{}, invalid("渠道或模型预设不存在")
	}
	result := VideoProbe{Authentication: "unverified", ModelCallable: "unverified", TaskSucceeded: "unverified"}
	if err := validateChannel(channel); err != nil {
		result.Message = err.Error()
		return result, nil
	}
	result.ConfigValid = true
	if channel.withoutKey() {
		result.Authentication = "not_required"
	}
	provider := s.adapter(ProviderProfile{Provider: channel.Protocol, Channel: &channel, Model: model}, key)
	switch verifier := provider.(type) {
	case interface {
		Probe(context.Context, string) VideoProbe
	}:
		result = verifier.Probe(ctx, model)
	case interface{ Verify(context.Context) error }:
		if key == "" {
			result.Message = "请先保存渠道密钥"
		} else if err := verifier.Verify(ctx); err != nil {
			result.Message = (videoHTTP{key: key}).safeMessage(err.Error())
			var response *providerRequestError
			if errors.As(err, &response) && (response.status == http.StatusUnauthorized || response.status == http.StatusForbidden) {
				result.Authentication = "failed"
			}
		} else {
			result.Authentication = "verified"
		}
	default:
		result.Message = "该渠道暂无可用的只读检查"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.channel(args.ID); ok && sameChannel(current, channel) && s.data.Keys[args.ID] == key {
		s.verification[args.ID] = result
		if model == "" && len(s.completed[args.ID]) > 0 || s.completed[args.ID][model] {
			result = successfulProbe(result, channel)
		}
	}
	return result, nil
}

func (s *ProviderSettings) recordCompleted(profile ProviderProfile, submittedKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	channel, exists := s.channel(profile.ChannelID)
	if !exists || profile.Channel == nil || !sameChannel(channel, *profile.Channel) ||
		s.data.Keys[channel.ID] != submittedKey {
		return
	}
	if s.completed[channel.ID] == nil {
		s.completed[channel.ID] = make(map[string]bool)
	}
	s.completed[channel.ID][profile.Model] = true
}

func successfulProbe(probe VideoProbe, channel VideoChannel) VideoProbe {
	probe.ConfigValid, probe.ModelCallable, probe.TaskSucceeded = true, "verified", "verified"
	if probe.Message == videoModelCatalogMessage {
		probe.Message = ""
	}
	if probe.Authentication == "" {
		probe.Authentication = "unverified"
		if channel.withoutKey() {
			probe.Authentication = "not_required"
		}
	}
	return probe
}
