package studio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

type providerRequestError struct {
	message   string
	status    int
	permanent bool
}

func (e *providerRequestError) Error() string   { return e.message }
func (e *providerRequestError) Permanent() bool { return e.permanent }

func permanentProviderError(message string) error {
	return &providerRequestError{message: message, permanent: true}
}

func submissionRejected(err error) bool {
	var response *providerRequestError
	if !errors.As(err, &response) {
		return false
	}
	switch response.status {
	case 400, 401, 402, 403, 404, 405, 413, 415, 422, 429:
		return true
	default:
		return false
	}
}

type videoHTTP struct {
	channel VideoChannel
	key     string
	client  *http.Client
}

func newVideoHTTP(channel VideoChannel, key string, client *http.Client) videoHTTP {
	if client == nil {
		client = http.DefaultClient
	}
	restricted := *client
	restricted.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return videoHTTP{channel: channel, key: key, client: &restricted}
}

func (p videoHTTP) endpoint(resource string) string {
	return strings.TrimRight(p.channel.BaseURL, "/") + "/" + strings.TrimLeft(resource, "/")
}

func (p videoHTTP) v1(resource string) string {
	if strings.HasSuffix(strings.TrimRight(p.channel.BaseURL, "/"), "/v1") {
		return p.endpoint(resource)
	}
	return p.endpoint("v1/" + resource)
}

func (p videoHTTP) request(ctx context.Context, method, endpoint, contentType string, body io.Reader) (*http.Response, error) {
	if !sameAPIOrigin(p.channel.BaseURL, endpoint) {
		return nil, permanentProviderError("API endpoint must use the configured channel origin")
	}
	return p.send(ctx, method, endpoint, contentType, body, true)
}

func (p videoHTTP) send(ctx context.Context, method, endpoint, contentType string, body io.Reader, authenticate bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, permanentProviderError("Invalid video API request URL")
	}
	if sized, ok := body.(interface{ Size() int64 }); ok {
		req.ContentLength = sized.Size()
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if authenticate && p.key != "" {
		advanced := p.channel.Advanced
		switch {
		case advanced == nil || advanced.Auth == "bearer":
			req.Header.Set("Authorization", "Bearer "+p.key)
		case advanced.Auth == "header":
			req.Header.Set(advanced.AuthHeader, p.key)
		}
	}
	response, err := p.client.Do(req)
	if err == nil {
		return response, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		err = requestErr.Err
	}
	return nil, fmt.Errorf("Video API request failed: %s", p.safeMessage(err.Error()))
}

func (p videoHTTP) json(ctx context.Context, method, endpoint string, body any) (map[string]any, error) {
	var reader io.Reader
	var contentType string
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, permanentProviderError("Could not encode video API request")
		}
		reader, contentType = bytes.NewReader(data), "application/json"
	}
	response, err := p.request(ctx, method, endpoint, contentType, reader)
	if err != nil {
		return nil, err
	}
	return p.jsonResponse(response)
}

func (p videoHTTP) jsonResponse(response *http.Response) (map[string]any, error) {
	defer response.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	decoder.UseNumber()
	var body map[string]any
	err := decoder.Decode(&body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, p.responseError(response.StatusCode, providerMessage(body))
	}
	if err != nil || body == nil || decoder.Decode(new(any)) != io.EOF {
		return nil, permanentProviderError("Video API did not return a valid JSON object")
	}
	return body, nil
}

func (p videoHTTP) responseError(status int, message string) error {
	message = p.safeMessage(message)
	if message != "" {
		message = ": " + message
	}
	return &providerRequestError{
		message:   fmt.Sprintf("Video API returned HTTP %d%s", status, message),
		status:    status,
		permanent: status < 500 && status != 408 && status != 425 && status != 429,
	}
}

var errorLink = regexp.MustCompile(`(?i)(?:https?://|data:)[^\s"'<>\x{3002}\x{ff0c}]+`)

func (p videoHTTP) safeMessage(message string) string {
	if p.key != "" {
		message = strings.ReplaceAll(message, p.key, "[redacted]")
		message = strings.ReplaceAll(message, url.QueryEscape(p.key), "[redacted]")
	}
	message = errorLink.ReplaceAllString(message, "[URL]")
	message = strings.Join(strings.Fields(message), " ")
	if runes := []rune(message); len(runes) > 300 {
		message = string(runes[:300]) + "…"
	}
	return message
}

func providerMessage(body map[string]any) string {
	for _, field := range []string{"error.message", "task.error.message", "data.error.message", "base_resp.status_msg",
		"fail_reason", "data.fail_reason", "error", "message"} {
		if message, ok := videoField(body, field).(string); ok && strings.TrimSpace(message) != "" {
			return message
		}
	}
	return ""
}

func providerOutputExtension(rawURL, mimeType string) string {
	switch strings.ToLower(strings.SplitN(mimeType, ";", 2)[0]) {
	case "video/webm", "webm":
		return ".webm"
	case "video/quicktime", "mov":
		return ".mov"
	case "video/mp4", "mp4":
		return ".mp4"
	}
	if endpoint, err := url.Parse(rawURL); err == nil {
		switch extension := strings.ToLower(path.Ext(endpoint.Path)); extension {
		case ".webm", ".mov", ".mp4":
			return extension
		}
	}
	return ".mp4"
}

func (p videoHTTP) outputURL(raw string) (string, error) {
	if raw == "" {
		return "", permanentProviderError("Video API did not return a downloadable video")
	}
	base, _ := url.Parse(p.endpoint(""))
	reference, err := url.Parse(raw)
	if err != nil || base == nil || reference.User != nil || reference.Fragment != "" || reference.Opaque != "" {
		return "", permanentProviderError("Video API returned an invalid download URL")
	}
	endpoint := base.ResolveReference(reference)
	if endpoint.Scheme != "https" && endpoint.Scheme != "http" || endpoint.Hostname() == "" ||
		!sameAPIOrigin(p.channel.BaseURL, endpoint.String()) && !providerURL(endpoint.String()) {
		return "", permanentProviderError("Video API returned an unsupported download URL")
	}
	return endpoint.String(), nil
}

func (p videoHTTP) download(ctx context.Context, result ProviderResult, writer io.Writer) error {
	return p.downloadOutput(ctx, result, writer, true)
}

func (p videoHTTP) downloadExternal(ctx context.Context, result ProviderResult, writer io.Writer) error {
	return p.downloadOutput(ctx, result, writer, false)
}

func (p videoHTTP) downloadOutput(ctx context.Context, result ProviderResult, writer io.Writer, allowKey bool) error {
	endpoint, err := p.outputURL(result.URL)
	if err != nil {
		return err
	}
	for redirects := 0; redirects < 5; redirects++ {
		auth := allowKey && sameAPIOrigin(p.channel.BaseURL, endpoint)
		response, err := p.send(ctx, http.MethodGet, endpoint, "", nil, auth)
		if err != nil {
			return err
		}
		if response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 ||
			response.StatusCode == 307 || response.StatusCode == 308 {
			location, err := response.Location()
			response.Body.Close()
			if err != nil {
				return permanentProviderError("Video download redirect has no valid destination")
			}
			endpoint, err = p.outputURL(location.String())
			if err != nil {
				return err
			}
			allowKey = auth
			continue
		}
		if response.StatusCode != http.StatusOK {
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				response.Body.Close()
				return permanentProviderError("Video download did not return a complete file")
			}
			_, err := p.jsonResponse(response)
			return err
		}
		return copyVideoOutput(response, writer)
	}
	return permanentProviderError("Video download exceeded the redirect limit")
}

func copyVideoOutput(response *http.Response, writer io.Writer) error {
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	probe, err := reader.Peek(512)
	if err != nil && err != io.EOF {
		return err
	}
	if !isVideoOutput(probe) {
		return permanentProviderError("Video download did not contain an MP4, MOV or WebM file")
	}
	const maxBytes = 1 << 30
	n, err := io.Copy(writer, io.LimitReader(reader, maxBytes+1))
	if err == nil && n > maxBytes {
		return permanentProviderError("Video download exceeds 1 GiB")
	}
	return err
}

func isVideoOutput(probe []byte) bool {
	format := http.DetectContentType(probe)
	quickTime := len(probe) >= 8 && slices.Contains([]string{"ftyp", "moov", "wide", "mdat", "free"}, string(probe[4:8]))
	return format == "video/mp4" || format == "video/webm" || quickTime
}

func readVideoMedia(input GenerationInput, ref GenerationReference, limit int64) (io.ReadCloser, string, error) {
	if ref.Type == "image" {
		return openImageReference(input, ref, limit)
	}
	formats := map[string]string{
		"video/.mp4": "video/mp4", "video/.mov": "video/quicktime", "video/.webm": "video/webm", "video/.m4v": "video/mp4",
		"audio/.wav": "audio/wav", "audio/.mp3": "audio/mpeg", "audio/.m4a": "audio/mp4", "audio/.ogg": "audio/ogg",
	}
	mime := formats[ref.Type+"/"+strings.ToLower(path.Ext(ref.Path))]
	prefix := "assets/"
	if ref.Type == "audio" {
		prefix = "assets/audio/"
	}
	if mime == "" || !strings.HasPrefix(ref.Path, prefix) ||
		!filepath.IsLocal(ref.Path) || filepath.ToSlash(filepath.Clean(ref.Path)) != ref.Path {
		return nil, "", errors.New("Invalid project video or audio reference")
	}
	root, err := os.OpenRoot(input.WorkspacePath)
	if err != nil {
		return nil, "", errors.New("Could not open the reference workspace")
	}
	defer root.Close()
	file, err := root.Open(ref.Path)
	if err != nil {
		return nil, "", errors.New("Could not open the project media")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		_ = file.Close()
		return nil, "", errors.New("Project media exceeds the provider limit or is unreadable")
	}
	return file, mime, nil
}

func videoMediaValue(input GenerationInput, ref GenerationReference, remaining *int64) (string, error) {
	if ref.URL != "" && providerURL(ref.URL) {
		return ref.URL, nil
	}
	if ref.Path == "" {
		return "", errors.New("Video reference needs an accessible HTTP/HTTPS URL or a project asset")
	}
	file, mime, err := readVideoMedia(input, ref, *remaining)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, *remaining+1))
	if err != nil || int64(len(data)) > *remaining {
		return "", errors.New("Could not read project media within the upload limit")
	}
	*remaining -= int64(len(data))
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
