package studio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const (
	arkChinaOrigin     = "https://ark.cn-beijing.volces.com"
	arkSingaporeOrigin = "https://ark.ap-southeast.bytepluses.com"
	arkTasksPath       = "/api/v3/contents/generations/tasks"
	arkMaxImageBytes   = 30_000_000
	arkMaxBodyBytes    = 64_000_000
)

type arkProvider struct {
	profile ProviderProfile
	apiKey  string
	origin  string
	client  *http.Client
}

func newArkProvider(profile ProviderProfile, apiKey string, client *http.Client) Provider {
	origin := arkChinaOrigin
	if profile.Provider == "byteplus" {
		origin = arkSingaporeOrigin
	}
	if client == nil {
		client = http.DefaultClient
	}
	// Inference uses a fixed origin. Never forward a provider credential through redirects.
	transport := *client
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &arkProvider{profile: profile, apiKey: strings.TrimSpace(apiKey), origin: origin, client: &transport}
}

func arkModelFamily(profile ProviderProfile) string {
	model := profile.Model
	prefix := "doubao-"
	if profile.Provider == "byteplus" {
		prefix = "dreamina-"
	}
	switch model {
	case prefix + "seedance-2-5-260628":
		return "2.5"
	case prefix + "seedance-2-0-260128", prefix + "seedance-2-0-fast-260128", prefix + "seedance-2-0-mini-260615":
		return "2.0"
	}
	legacyPrefix := prefix
	if profile.Provider == "byteplus" {
		legacyPrefix = ""
	}
	switch model {
	case legacyPrefix + "seedance-1-0-pro-250528", legacyPrefix + "seedance-1-0-pro-fast-251015":
		return "1.0"
	}
	if strings.HasPrefix(model, "ep-") {
		return "endpoint"
	}
	return ""
}

func validateArkProfile(profile ProviderProfile) error {
	if strings.TrimSpace(profile.Model) == "" {
		return errors.New("Ark requires a model or inference endpoint ID")
	}
	modelFamily := arkModelFamily(profile)
	switch profile.Mode {
	case "t2v":
	case "i2v":
		if modelFamily == "2.5" && profile.AspectRatio != "" && profile.AspectRatio != "adaptive" {
			return errors.New("Seedance 2.5 I2V derives the ratio from the first frame; use adaptive or leave the ratio blank")
		}
	case "r2v":
		if modelFamily != "2.5" && modelFamily != "2.0" && modelFamily != "endpoint" {
			return errors.New("Ark R2V requires a Seedance 2.0/2.5 model or an endpoint deploying one")
		}
	default:
		return errors.New("Ark supports T2V, I2V and R2V video modes")
	}

	switch profile.AspectRatio {
	case "", "adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9":
	default:
		return errors.New("Ark video ratio is unsupported")
	}

	duration := profile.Duration
	validDuration := duration == 0 || duration == -1 || (duration >= 2 && duration <= 30)
	switch modelFamily {
	case "2.5":
		validDuration = duration == 0 || duration == -1 || (duration >= 4 && duration <= 30)
	case "2.0":
		validDuration = duration == 0 || duration == -1 || (duration >= 4 && duration <= 15)
	case "1.0":
		validDuration = duration == 0 || (duration >= 2 && duration <= 12)
	}
	if !validDuration {
		return errors.New("Ark duration is outside this model's supported range")
	}

	for option, value := range profile.Options {
		switch option {
		case "resolution":
			resolution, _ := value.(string)
			if resolution != "480p" && resolution != "720p" && resolution != "1080p" && resolution != "4K" {
				return errors.New("Ark resolution must be 480p, 720p, 1080p or 4K")
			}
			fastOrMini := strings.HasSuffix(profile.Model, "-fast-260128") || strings.HasSuffix(profile.Model, "-mini-260615")
			if (resolution == "1080p" && modelFamily == "2.0" && fastOrMini) ||
				(resolution == "4K" && (modelFamily == "2.5" || modelFamily == "1.0" || modelFamily == "2.0" && fastOrMini)) {
				return errors.New("Ark resolution is unavailable for this model")
			}
		case "generate_audio", "watermark":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("Ark option %s must be a boolean", option)
			}
			if option == "generate_audio" && modelFamily == "1.0" {
				return errors.New("Seedance 1.0 has no generate_audio option")
			}
		default:
			return errors.New("Ark options are limited to resolution, generate_audio and watermark")
		}
	}
	return nil
}

func (p *arkProvider) Validate(input GenerationInput) error {
	if err := validateArkProfile(p.profile); err != nil {
		return err
	}
	if input.Type != "video" || strings.TrimSpace(input.Prompt) == "" {
		return errors.New("Ark requires a video prompt")
	}
	if input.Mode != "" && input.Mode != p.profile.Mode {
		return errors.New("Ark profile mode does not match the video draft")
	}
	count := len(input.References)
	switch p.profile.Mode {
	case "t2v":
		if count != 0 {
			return errors.New("Ark T2V accepts a prompt without media inputs")
		}
	case "i2v":
		if count != 1 {
			return errors.New("Ark I2V requires one first-frame image")
		}
	case "r2v":
		maxImages := 9
		if arkModelFamily(p.profile) == "2.5" {
			maxImages = 30
		}
		if count == 0 || count > maxImages {
			return fmt.Errorf("Ark R2V accepts 1–%d ordered reference images for this profile", maxImages)
		}
	}
	for _, ref := range input.References {
		if ref.Type != "image" || (ref.URL == "" && ref.Path == "") || (ref.URL != "" && !providerURL(ref.URL)) {
			return errors.New("Ark video inputs must be images with a public HTTP(S) URL or a local image path")
		}
	}
	return nil
}

func arkImageURL(input GenerationInput, ref GenerationReference) (string, error) {
	if ref.URL != "" {
		return ref.URL, nil
	}
	file, mime, err := openImageReference(input, ref, arkMaxImageBytes-1)
	if err != nil {
		return "", err
	}
	defer file.Close()
	switch mime {
	case "image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif":
	default:
		return "", errors.New("Ark local reference uses an unsupported image format")
	}
	raw, err := io.ReadAll(io.LimitReader(file, arkMaxImageBytes))
	if err != nil || len(raw) == 0 || len(raw) >= arkMaxImageBytes {
		return "", errors.New("Ark local image must be nonempty and under 30 MB")
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func (p *arkProvider) payload(input GenerationInput) ([]byte, error) {
	if err := p.Validate(input); err != nil {
		return nil, err
	}
	content := []map[string]any{{"type": "text", "text": input.Prompt}}
	size := len(input.Prompt)
	role := "reference_image"
	if p.profile.Mode == "i2v" {
		role = "first_frame"
	}
	for _, ref := range input.References {
		imageURL, err := arkImageURL(input, ref)
		if err != nil {
			return nil, err
		}
		size += len(imageURL)
		if size >= arkMaxBodyBytes {
			return nil, errors.New("Ark request exceeds the 64 MB limit")
		}
		content = append(content, map[string]any{
			"type": "image_url", "role": role, "image_url": map[string]string{"url": imageURL},
		})
	}

	body := map[string]any{"model": p.profile.Model, "content": content}
	if p.profile.Mode == "r2v" && arkModelFamily(p.profile) == "2.5" {
		body["omni_reference_task_type"] = "reference"
	}
	if p.profile.Duration != 0 {
		body["duration"] = p.profile.Duration
	}
	if p.profile.AspectRatio != "" {
		body["ratio"] = p.profile.AspectRatio
	}
	for key, value := range p.profile.Options {
		body[key] = value
	}
	wire, err := json.Marshal(body)
	if err == nil && len(wire) > arkMaxBodyBytes {
		return nil, errors.New("Ark request exceeds the 64 MB limit")
	}
	return wire, err
}

func (p *arkProvider) request(ctx context.Context, method, resource string, payload []byte) (*http.Response, error) {
	if p.apiKey == "" {
		return nil, errors.New("Ark API key is missing")
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.origin+arkTasksPath+resource, body)
	if err != nil {
		return nil, errors.New("Could not create Ark API request")
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("Could not reach Ark API")
	}
	return res, nil
}

func (p *arkProvider) Submit(ctx context.Context, input GenerationInput) (ProviderSubmission, error) {
	wire, err := p.payload(input)
	if err != nil {
		return ProviderSubmission{Rejected: true}, err
	}
	if p.apiKey == "" {
		return ProviderSubmission{Rejected: true}, errors.New("Ark API key is missing")
	}
	res, err := p.request(ctx, http.MethodPost, "", wire)
	if err != nil {
		return ProviderSubmission{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// These responses are definitive rejections under the Ark error contract.
		rejected := false
		switch res.StatusCode {
		case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests:
			rejected = true
		}
		return ProviderSubmission{Rejected: rejected}, fmt.Errorf("Ark create task returned HTTP %d", res.StatusCode)
	}
	var task struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&task); err != nil || !validArkTaskID(task.ID) {
		return ProviderSubmission{}, errors.New("Ark returned no valid task ID; submission outcome is unknown")
	}
	return ProviderSubmission{TaskID: task.ID}, nil
}

func validArkTaskID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	return strings.IndexFunc(id, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_'
	}) < 0
}

func (p *arkProvider) Poll(ctx context.Context, id string) (ProviderResult, error) {
	if !validArkTaskID(id) {
		return ProviderResult{}, errors.New("Invalid Ark task ID")
	}
	res, err := p.request(ctx, http.MethodGet, "/"+id, nil)
	if err != nil {
		return ProviderResult{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ProviderResult{}, fmt.Errorf("Ark query task returned HTTP %d", res.StatusCode)
	}
	var task struct {
		ID           string `json:"id"`
		Status       string `json:"status"`
		OutputFormat string `json:"output_format"`
		Content      struct {
			VideoURL string `json:"video_url"`
		} `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&task); err != nil || task.ID != id {
		return ProviderResult{}, errors.New("Ark returned an invalid task response")
	}
	switch task.Status {
	case "queued":
		return ProviderResult{Status: "pending"}, nil
	case "running":
		return ProviderResult{Status: "running"}, nil
	case "failed", "cancelled", "expired":
		return ProviderResult{Status: "failed"}, nil
	case "succeeded":
		if !arkOutputURL(task.Content.VideoURL) {
			return ProviderResult{}, errors.New("Ark did not return a valid HTTPS video URL")
		}
		switch task.OutputFormat {
		case "", "mp4":
			return ProviderResult{Status: "succeeded", URL: task.Content.VideoURL, Extension: ".mp4"}, nil
		case "mov":
			return ProviderResult{Status: "succeeded", URL: task.Content.VideoURL, Extension: ".mov"}, nil
		default:
			return ProviderResult{}, errors.New("Ark returned an unsupported output format")
		}
	default:
		return ProviderResult{}, errors.New("Ark returned an unknown task status")
	}
}

func arkOutputURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && providerURL(value)
}

func (p *arkProvider) Download(ctx context.Context, result ProviderResult, writer io.Writer) error {
	if !arkOutputURL(result.URL) {
		return errors.New("Ark output URL must be public HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, result.URL, nil)
	if err != nil {
		return errors.New("Could not create Ark video download request")
	}
	res, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Could not download Ark video")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Ark video download returned HTTP %d", res.StatusCode)
	}
	_, err = io.Copy(writer, res.Body)
	return err
}

func (p *arkProvider) Verify(ctx context.Context) error {
	res, err := p.request(ctx, http.MethodGet, "?page_num=1&page_size=1", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Ark list tasks returned HTTP %d", res.StatusCode)
	}
	var result struct {
		Total *int64 `json:"total"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&result); err != nil || result.Total == nil {
		return errors.New("Ark did not return a valid task listing")
	}
	return nil
}
