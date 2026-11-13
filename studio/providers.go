package studio

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/google/uuid"
)

type ProviderProfile struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Provider    string         `json:"provider"`
	Mode        string         `json:"mode"`
	Model       string         `json:"model"`
	InputField  string         `json:"inputField,omitempty"`
	AspectRatio string         `json:"aspectRatio,omitempty"`
	Duration    int            `json:"duration,omitempty"`
	Options     map[string]any `json:"options,omitempty"`
	ChannelID   string         `json:"channelId,omitempty"`
	ArkFamily   string         `json:"arkFamily,omitempty"`
	Modes       []string       `json:"modes,omitempty"`
	Defaults    VideoParams    `json:"defaults,omitzero"`
	Limits      VideoLimits    `json:"limits,omitzero"`
	Channel     *VideoChannel  `json:"channel,omitempty"`
}

type providerRegistry interface {
	Prepare(*GenerationInput, string) error
	Resolve(ProviderProfile) (Provider, error)
}

type resolvedChannelProvider struct {
	Provider
	onCompleted func()
}

type providerData struct {
	Profiles   []ProviderProfile  `json:"profiles"`
	Keys       map[string]string  `json:"keys,omitempty"`
	Defaults   map[string]string  `json:"defaults,omitempty"`
	Channels   []VideoChannel     `json:"channels"`
	Retired    []string           `json:"retired,omitempty"`
	Generation GenerationSettings `json:"generation"`
}

type providerView struct {
	ProviderProfile
	Configured bool     `json:"configured"`
	Default    bool     `json:"default"`
	Parameters []string `json:"parameters"`
}

type ProviderSettings struct {
	mu           sync.RWMutex
	data         providerData
	client       *http.Client
	legacyPath   string
	verification map[string]VideoProbe
	completed    map[string]map[string]bool
}

var providerNames = []string{"ark", "byteplus", "replicate"}
var modeNames = []string{"t2i", "t2v", "i2v", "r2v"}

func readLegacyProviderSettings(path string) (providerData, error) {
	var data providerData
	encrypted, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return data, errors.New("Could not read provider settings")
	}
	cleartext, err := providerSecret(encrypted, false)
	if err != nil || json.Unmarshal(cleartext, &data) != nil {
		return providerData{}, errors.New("Could not decrypt provider settings for this Windows user")
	}
	return data, nil
}

func (s *ProviderSettings) view() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profiles := make([]providerView, 0, len(s.data.Profiles))
	for _, p := range s.data.Profiles {
		key := p.ChannelID
		if key == "" {
			key = p.Provider
		}
		configured := s.data.Keys[key] != ""
		var channel *VideoChannel
		if c, ok := s.channel(key); ok {
			configured = configured || c.withoutKey()
			channel = &c
		}
		if slices.Contains(providerNames, p.Provider) && len(p.Limits.References) == 0 &&
			(p.Mode == "r2v" || slices.Contains(p.Modes, "r2v")) {
			p.Limits.References = map[string]int{"image": 32}
		}
		profiles = append(profiles, providerView{
			ProviderProfile: p, Configured: configured,
			Default:    s.data.Generation.DefaultModelID == p.ID || s.data.Defaults[p.Mode] == p.ID,
			Parameters: supportedVideoParams(p, channel),
		})
	}
	channels := make([]channelView, 0, len(s.data.Channels))
	for _, c := range s.data.Channels {
		probe := s.verification[c.ID]
		if len(s.completed[c.ID]) > 0 {
			probe = successfulProbe(probe, c)
		}
		channels = append(channels, channelView{
			VideoChannel: c, Configured: s.data.Keys[c.ID] != "", Verification: probe,
			Modes: videoChannelModes(c),
		})
	}
	return map[string]any{"profiles": profiles, "templates": modelTemplates(), "channels": channels, "generation": s.data.Generation}
}

func modelTemplates() []ProviderProfile {
	return append(providerTemplates(), ProviderProfile{
		Name: "MiniMax H3", Provider: minimaxH3Protocol, Model: minimaxH3Model,
		Modes: []string{"t2v", "i2v", "r2v"}, Defaults: VideoParams{Duration: 4, Resolution: "768P", AspectRatio: "16:9"},
		Limits: VideoLimits{DurationMin: 4, DurationMax: 15, Resolutions: []string{"768P", "2K"}, LastFrame: true,
			AspectRatios: []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"},
			References:   map[string]int{"image": 9, "video": 3, "audio": 3}},
	})
}

func providerTemplates() []ProviderProfile {
	var profiles []ProviderProfile
	for _, provider := range []string{"ark", "byteplus"} {
		model := "doubao-seedance-2-0-260128"
		if provider == "byteplus" {
			model = "dreamina-seedance-2-0-260128"
		}
		for _, mode := range []string{"t2v", "i2v", "r2v"} {
			profiles = append(profiles, ProviderProfile{Name: "Seedance 2.0 · " + strings.ToUpper(mode), Provider: provider, Mode: mode, Model: model})
		}
	}
	for _, template := range []struct{ name, mode, model, field string }{
		{"Wan 2.7 · T2V", "t2v", "wan-video/wan-2.7-t2v", ""},
		{"Wan 2.7 · I2V", "i2v", "wan-video/wan-2.7-i2v", "first_frame"},
		{"Wan 2.7 · R2V", "r2v", "wan-video/wan-2.7-r2v", "reference_images"},
		{"Veo 3.1 · T2V", "t2v", "google/veo-3.1", ""},
		{"Veo 3.1 · I2V", "i2v", "google/veo-3.1", "image"},
		{"Veo 3.1 · R2V", "r2v", "google/veo-3.1", "reference_images"},
		{"Kling 3.0 Omni · T2V", "t2v", "kwaivgi/kling-v3-omni-video", ""},
		{"Kling 3.0 Omni · I2V", "i2v", "kwaivgi/kling-v3-omni-video", "start_image"},
		{"Kling 3.0 Omni · R2V", "r2v", "kwaivgi/kling-v3-omni-video", "reference_images"},
		{"Hailuo 2.3 · T2V", "t2v", "minimax/hailuo-2.3", ""},
		{"Hailuo 2.3 · I2V", "i2v", "minimax/hailuo-2.3", "first_frame_image"},
		{"FLUX Schnell · T2I", "t2i", "black-forest-labs/flux-schnell", ""},
	} {
		profiles = append(profiles, ProviderProfile{Name: template.name, Provider: "replicate", Mode: template.mode, Model: template.model, InputField: template.field})
	}
	return profiles
}

var profileModel = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$")
var fieldName = regexp.MustCompile("^[A-Za-z][A-Za-z0-9_]{0,63}$")
var ratioName = regexp.MustCompile("^(adaptive|[1-9][0-9]?:[1-9][0-9]?)$")

func validateProfile(profile ProviderProfile) error {
	if !slices.Contains(providerNames, profile.Provider) || !slices.Contains(modeNames, profile.Mode) {
		return invalid("请选择已支持的供应商和生成方式")
	}
	if profile.Provider != "replicate" && profile.Mode == "t2i" {
		return invalid("当前供应商只支持视频预设")
	}
	if len(profile.Name) == 0 || len(profile.Name) > 160 || !profileModel.MatchString(profile.Model) || strings.Contains(profile.Model, "..") {
		return invalid("需要有效的预设名称和模型 ID")
	}
	if profile.ID != "" {
		if id, err := uuid.Parse(profile.ID); err != nil || id.String() != profile.ID {
			return invalid("预设 ID 无效")
		}
	}
	hasInput := profile.Mode == "i2v" || profile.Mode == "r2v" || profile.Mode == "t2i" && profile.InputField != ""
	if profile.Mode == "t2i" && (profile.InputField != "") != (profile.Limits.References["image"] > 0) {
		return invalid("参考图需要配置图片输入字段和数量上限")
	}
	if profile.Provider == "replicate" && hasInput {
		if !fieldName.MatchString(profile.InputField) || strings.Contains(strings.ToLower(profile.InputField), "prompt") ||
			slices.Contains([]string{"duration", "aspect_ratio", "resolution", "seed", "generate_audio", "output_format"}, profile.InputField) {
			return invalid("图像输入字段必须与模型官方 schema 一致")
		}
	} else if profile.InputField != "" {
		return invalid("该供应商或生成方式不使用自定义素材字段")
	}
	if profile.Duration < -1 || profile.Duration > 60 || (profile.Provider == "replicate" && profile.Duration < 0) ||
		(profile.AspectRatio != "" && !ratioName.MatchString(profile.AspectRatio)) {
		return invalid("时长或画面比例无效，请按模型文档填写")
	}
	if profile.Mode == "t2i" && profile.Duration != 0 {
		return invalid("图片预设不使用时长")
	}
	if len(profile.Options) > 24 {
		return invalid("模型参数过多")
	}
	for key, value := range profile.Options {
		field := strings.ToLower(key)
		if !fieldName.MatchString(key) || key == profile.InputField ||
			strings.Contains(field, "prompt") || strings.Contains(field, "secret") ||
			slices.Contains([]string{"key", "apikey", "api_key", "token", "authorization"}, field) ||
			slices.Contains([]string{"video", "videos", "image", "images", "audio", "references", "reference_images", "reference_videos", "reference_audio", "first_frame", "last_frame"}, strings.ToLower(key)) {
			return invalid("模型参数不能覆盖提示词或素材输入")
		}
		switch v := value.(type) {
		case bool, float64:
		case string:
			if len(v) > 256 || strings.Contains(v, "://") || strings.HasPrefix(strings.ToLower(v), "data:") {
				return invalid("模型参数只能包含短枚举值或标量")
			}
		default:
			return invalid("模型参数只能包含短枚举值或标量")
		}
	}
	if profile.Provider != "replicate" {
		if strings.ContainsAny(profile.Model, "/:") {
			return invalid("方舟模型 ID 不能包含斜线或版本分隔符")
		}
		if err := validateArkProfile(profile); err != nil {
			return invalid("%s", err)
		}
		return nil
	}
	sample := GenerationInput{Type: "video", Mode: profile.Mode, Prompt: "Validation only"}
	if profile.Mode == "t2i" {
		sample.Type = "image"
	}
	if hasInput {
		sample.References = []GenerationReference{{Type: "image", Path: "assets/images/validation.png"}}
	}
	if _, _, err := replicateRequest(profile, sample); err != nil {
		return invalid("%s", err)
	}
	return nil
}

func (s *ProviderSettings) Prepare(input *GenerationInput, id string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.prepareChannel(input, id)
}

func (s *ProviderSettings) Resolve(profile ProviderProfile) (Provider, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if profile.ID == "" {
		return nil, errors.New("Task has no provider preset")
	}
	keyID := profile.ChannelID
	if keyID == "" {
		keyID = profile.Provider
	}
	key := s.data.Keys[keyID]
	if key == "" && (profile.Channel == nil || !profile.Channel.withoutKey()) {
		return nil, providerUnavailable
	}
	provider := s.adapter(profile, key)
	if provider == nil {
		return nil, providerUnavailable
	}
	if profile.Channel != nil && profile.Mode != "t2i" {
		return &resolvedChannelProvider{Provider: provider, onCompleted: func() {
			s.recordCompleted(profile, key)
		}}, nil
	}
	return provider, nil
}

func (s *ProviderSettings) adapter(profile ProviderProfile, key string) Provider {
	switch profile.Provider {
	case "ark", "byteplus":
		return newArkProvider(profile, key, s.client)
	case "replicate":
		return newReplicateProvider(profile, key, s.client)
	case "new-api", "openai-video", "custom-rest":
		return newVideoProvider(profile, key, s.client)
	case minimaxH3Protocol:
		return newMinimaxProvider(profile, key, s.client)
	}
	return nil
}

func (s *ProviderSettings) execute(ctx context.Context, action string, raw json.RawMessage) (any, error) {
	if action != "provider_settings" {
		return s.executeProfileSettings(ctx, action, raw)
	}
	if err := decodeData(raw, &struct{}{}); err != nil {
		return nil, err
	}
	return s.view(), nil
}

func openImageReference(input GenerationInput, ref GenerationReference, limit int64) (io.ReadCloser, string, error) {
	if ref.Type != "image" || !strings.HasPrefix(ref.Path, "assets/images/") ||
		!filepath.IsLocal(ref.Path) || filepath.ToSlash(filepath.Clean(ref.Path)) != ref.Path {
		return nil, "", errors.New("Invalid project image reference")
	}
	root, err := os.OpenRoot(input.WorkspacePath)
	if err != nil {
		return nil, "", errors.New("Could not open the reference workspace")
	}
	defer root.Close()
	file, err := root.Open(ref.Path)
	if err != nil {
		return nil, "", errors.New("Could not open the project image")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		_ = file.Close()
		return nil, "", errors.New("Project image exceeds the provider limit or is unreadable")
	}
	probe := make([]byte, 512)
	n, err := file.Read(probe)
	if err != nil && !errors.Is(err, io.EOF) {
		_ = file.Close()
		return nil, "", errors.New("Could not read project image")
	}
	mime := http.DetectContentType(probe[:n])
	if !slices.Contains([]string{"image/png", "image/jpeg", "image/webp", "image/gif"}, mime) {
		_ = file.Close()
		return nil, "", errors.New("Project image must be PNG, JPEG, WebP or GIF")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, "", errors.New("Could not read project image")
	}
	return file, mime, nil
}
