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
}

type providerRegistry interface {
	Prepare(*GenerationInput, string) error
	Resolve(ProviderProfile) (Provider, error)
}

type providerData struct {
	Profiles []ProviderProfile `json:"profiles"`
	Keys     map[string]string `json:"keys"`
	Defaults map[string]string `json:"defaults"`
}

type providerView struct {
	ProviderProfile
	Configured bool `json:"configured"`
	Default    bool `json:"default"`
}

type ProviderSettings struct {
	mu     sync.RWMutex
	path   string
	data   providerData
	client *http.Client
}

var providerNames = []string{"ark", "byteplus", "replicate"}
var modeNames = []string{"t2i", "t2v", "i2v", "r2v"}

func OpenProviderSettings(path string) (*ProviderSettings, error) {
	settings := &ProviderSettings{
		path: path, data: providerData{Keys: make(map[string]string), Defaults: make(map[string]string)},
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
	encrypted, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return nil, errors.New("Could not read provider settings")
	}
	cleartext, err := providerSecret(encrypted, false)
	if err != nil || json.Unmarshal(cleartext, &settings.data) != nil {
		return nil, errors.New("Could not decrypt provider settings for this Windows user")
	}
	return settings, nil
}

func (s *ProviderSettings) view() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profiles := make([]providerView, 0, len(s.data.Profiles))
	for _, p := range s.data.Profiles {
		profiles = append(profiles, providerView{p, s.data.Keys[p.Provider] != "", s.data.Defaults[p.Mode] == p.ID})
	}
	return map[string]any{"profiles": profiles, "templates": providerTemplates()}
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
	hasInput := profile.Mode == "i2v" || profile.Mode == "r2v"
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

func (s *ProviderSettings) save(profile ProviderProfile, apiKey *string, makeDefault bool) error {
	profile.Name = strings.TrimSpace(profile.Name)
	profile.Model = strings.TrimSpace(profile.Model)
	profile.InputField = strings.TrimSpace(profile.InputField)
	profile.AspectRatio = strings.TrimSpace(profile.AspectRatio)
	if err := validateProfile(profile); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneProviderData(s.data)
	if apiKey != nil {
		key := strings.TrimSpace(*apiKey)
		if len(key) > 512 || strings.ContainsAny(key, "\r\n\t ") {
			return invalid("API 密钥格式无效")
		}
		if key == "" {
			delete(next.Keys, profile.Provider)
		} else {
			next.Keys[profile.Provider] = key
		}
	}
	if profile.ID == "" {
		if len(next.Profiles) >= 64 {
			return invalid("最多保存 64 个生成预设")
		}
		profile.ID = uuid.NewString()
		next.Profiles = append(next.Profiles, profile)
	} else {
		index := slices.IndexFunc(next.Profiles, func(p ProviderProfile) bool { return p.ID == profile.ID })
		if index < 0 {
			return invalid("预设不存在，请刷新设置")
		}
		old := next.Profiles[index]
		if old.Provider != profile.Provider || old.Mode != profile.Mode {
			return invalid("更换供应商或生成方式时请新建预设")
		}
		next.Profiles[index] = profile
	}
	if makeDefault {
		next.Defaults[profile.Mode] = profile.ID
	} else if next.Defaults[profile.Mode] == profile.ID {
		delete(next.Defaults, profile.Mode)
	}
	return s.persist(next)
}

func (s *ProviderSettings) remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneProviderData(s.data)
	index := slices.IndexFunc(next.Profiles, func(p ProviderProfile) bool { return p.ID == id })
	if index < 0 {
		return invalid("预设不存在，请刷新设置")
	}
	mode := next.Profiles[index].Mode
	next.Profiles = slices.Delete(next.Profiles, index, index+1)
	if next.Defaults[mode] == id {
		delete(next.Defaults, mode)
	}
	return s.persist(next)
}

func cloneProviderData(data providerData) providerData {
	next := providerData{Profiles: slices.Clone(data.Profiles), Keys: make(map[string]string), Defaults: make(map[string]string)}
	for key, value := range data.Keys {
		next.Keys[key] = value
	}
	for key, value := range data.Defaults {
		next.Defaults[key] = value
	}
	return next
}

func (s *ProviderSettings) persist(next providerData) error {
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	protected, err := providerSecret(raw, true)
	if err != nil {
		return errors.New("Could not protect provider settings")
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("Could not create provider settings directory")
	}
	file, err := os.CreateTemp(dir, ".providers-*")
	if err != nil {
		return errors.New("Could not write provider settings")
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(protected)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return errors.New("Could not write provider settings")
	}
	if err := os.Rename(file.Name(), s.path); err != nil {
		return errors.New("Could not replace provider settings")
	}
	s.data = next
	return nil
}

func (s *ProviderSettings) Prepare(input *GenerationInput, id string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if id == "" {
		id = s.data.Defaults[input.Mode]
	}
	var selected ProviderProfile
	if id != "" {
		for _, profile := range s.data.Profiles {
			if profile.ID == id {
				selected = profile
				break
			}
		}
		if selected.ID == "" || selected.Mode != input.Mode {
			return invalid("所选预设不存在或与生成方式不匹配")
		}
	} else {
		for _, profile := range s.data.Profiles {
			if profile.Mode != input.Mode || s.data.Keys[profile.Provider] == "" {
				continue
			}
			if selected.ID != "" {
				return invalid("请指定该生成方式的默认预设或选择一个预设")
			}
			selected = profile
		}
	}
	if selected.ID == "" || s.data.Keys[selected.Provider] == "" {
		return providerUnavailable
	}
	input.Profile = selected
	provider := s.adapter(selected, s.data.Keys[selected.Provider])
	if validator, ok := provider.(interface{ Validate(GenerationInput) error }); ok {
		if err := validator.Validate(*input); err != nil {
			return invalid("%s", err)
		}
	}
	return nil
}

func (s *ProviderSettings) Resolve(profile ProviderProfile) (Provider, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if profile.ID == "" {
		return nil, errors.New("Task has no provider preset")
	}
	key := s.data.Keys[profile.Provider]
	if key == "" {
		return nil, providerUnavailable
	}
	provider := s.adapter(profile, key)
	if provider == nil {
		return nil, providerUnavailable
	}
	return provider, nil
}

func (s *ProviderSettings) adapter(profile ProviderProfile, key string) Provider {
	switch profile.Provider {
	case "ark", "byteplus":
		return newArkProvider(profile, key, s.client)
	case "replicate":
		return newReplicateProvider(profile, key, s.client)
	}
	return nil
}

func (s *ProviderSettings) execute(ctx context.Context, action string, raw json.RawMessage) (any, error) {
	switch action {
	case "provider_settings":
		if err := decodeData(raw, &struct{}{}); err != nil {
			return nil, err
		}
	case "provider_save":
		var args struct {
			Profile     ProviderProfile `json:"profile"`
			APIKey      *string         `json:"apiKey"`
			MakeDefault bool            `json:"makeDefault"`
		}
		if err := decodeData(raw, &args); err != nil {
			return nil, err
		}
		if err := s.save(args.Profile, args.APIKey, args.MakeDefault); err != nil {
			return nil, err
		}
	case "provider_remove":
		var args struct {
			ID string `json:"id"`
		}
		if err := decodeData(raw, &args); err != nil {
			return nil, err
		}
		if err := s.remove(args.ID); err != nil {
			return nil, err
		}
	case "provider_test":
		var args struct {
			Provider string `json:"provider"`
		}
		if err := decodeData(raw, &args); err != nil {
			return nil, err
		}
		s.mu.RLock()
		key := s.data.Keys[args.Provider]
		s.mu.RUnlock()
		if key == "" {
			return nil, invalid("请先保存该供应商的密钥")
		}
		provider := s.adapter(ProviderProfile{Provider: args.Provider}, key)
		verifier, ok := provider.(interface{ Verify(context.Context) error })
		if !ok {
			return nil, invalid("该供应商没有可用的只读检查")
		}
		if err := verifier.Verify(ctx); err != nil {
			return nil, &requestError{http.StatusBadGateway, err.Error()}
		}
		return map[string]bool{"verified": true}, nil
	default:
		return nil, invalid("未知供应商设置操作")
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
