package studio

import (
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"maps"
	"slices"
	"strings"
)

func prepareVideoGeneration(input *GenerationInput, profile *ProviderProfile, global VideoParams) error {
	if input.Mode == "i2v" && len(input.References) == 2 && !profile.Limits.LastFrame {
		return invalid("所选模型不支持尾帧")
	}
	if input.Mode == "r2v" {
		if err := validateReferenceLimits(*profile, input.References); err != nil {
			return err
		}
	}
	model, overrides := *profile, input.Params
	if profile.Provider == minimaxH3Protocol && input.Mode == "i2v" {
		// H3 inherits the first frame's ratio. Preserve old drafts that carry
		// a ratio override without recording it as an executed parameter.
		model.Defaults.AspectRatio = ""
		model.Limits.AspectRatios = nil
		overrides.AspectRatio = ""
	}
	if ratio := input.productionAspectRatio; ratio != "" && overrides.AspectRatio == "" {
		if videoInheritsFirstFrameRatio(input.Mode, *profile) {
			model.Defaults.AspectRatio = ""
			model.Limits.AspectRatios = nil
		} else {
			// Dimensions-only protocols consume the ratio locally to build their
			// size/width/height fields, even when the preset only declares a resolution.
			if model.Channel != nil && usesVideoDimensions(*model.Channel) && model.Defaults.AspectRatio == "" {
				model.Defaults.AspectRatio = ratio
			}
			overrides.AspectRatio = ratio
		}
	}
	params, err := resolveVideoParams(model, global, overrides)
	if err != nil {
		return err
	}
	input.Params = params
	if profile.Provider == minimaxH3Protocol {
		input.Params = minimaxParams(*input)
		input.Params.Resolution = strings.ToUpper(input.Params.Resolution)
	}
	if slices.Contains(providerNames, profile.Provider) {
		profile.Duration, profile.AspectRatio = params.Duration, params.AspectRatio
		if params.Resolution != "" || params.GenerateAudio != nil {
			options := make(map[string]any, len(profile.Options)+2)
			maps.Copy(options, profile.Options)
			if params.Resolution != "" {
				options["resolution"] = params.Resolution
			}
			if params.GenerateAudio != nil {
				options["generate_audio"] = *params.GenerateAudio
			}
			profile.Options = options
		}
	}
	return nil
}

func videoInheritsFirstFrameRatio(mode string, profile ProviderProfile) bool {
	return mode == "i2v" && (profile.Provider == minimaxH3Protocol ||
		(profile.Provider == "ark" || profile.Provider == "byteplus") && arkContractFor(profile).family == arkSeedance25)
}

func checkProductionFirstFrame(file io.Reader, ratio string) error {
	config, _, err := image.DecodeConfig(file)
	if err != nil {
		return invalid("该模型从首帧继承画幅，请使用可核对画幅的项目内 PNG 或 JPEG 首帧")
	}
	w, h, ok := splitDimensions(ratio, ":")
	if !ok || !videoRatioMatches(config.Width, config.Height, w, h) {
		return invalid("首帧图片尺寸与 %s 制作规格不匹配，该模型从首帧继承画幅", ratio)
	}
	return nil
}

func validateReferenceLimits(profile ProviderProfile, references []GenerationReference) error {
	limits := profile.Limits
	if limits.MaxReferences > 0 && len(references) > limits.MaxReferences {
		return invalid("模型最多允许 %d 个参考素材", limits.MaxReferences)
	}
	counts := make(map[string]int, 3)
	for _, ref := range references {
		maximum := limits.References[ref.Type]
		if len(limits.References) == 0 && ref.Type == "image" && slices.Contains(providerNames, profile.Provider) {
			maximum = 32 // Legacy image-only presets retain their provider's own limit.
		}
		counts[ref.Type]++
		if counts[ref.Type] > maximum {
			return invalid("模型对 %s 参考素材的数量上限为 %d", ref.Type, maximum)
		}
	}
	return nil
}

func protocolAllowsParam(channel *VideoChannel, parameter string) bool {
	if channel == nil {
		return true
	}
	switch channel.Protocol {
	case "custom-rest":
		return channel.Advanced != nil && customWritePath(channel.Advanced, parameter) != ""
	case "new-api":
		if channel.TaskPlugin != "" && channel.TaskPlugin != "xai" {
			return false
		}
		return parameter != "generateAudio" || channel.TaskPlugin == "xai"
	case "openai-video", minimaxH3Protocol:
		return parameter != "generateAudio"
	default:
		return true
	}
}

func supportedVideoParams(profile ProviderProfile, channel *VideoChannel) []string {
	limits, defaults := profile.Limits, profile.Defaults
	parameters := make([]string, 0, 4)
	for _, item := range []struct {
		name      string
		supported bool
	}{
		{"duration", defaults.Duration != 0 || limits.DurationMin != 0 || limits.DurationMax != 0 || len(limits.Durations) != 0},
		{"resolution", defaults.Resolution != "" || len(limits.Resolutions) != 0},
		{"aspectRatio", defaults.AspectRatio != "" || len(limits.AspectRatios) != 0},
		{"generateAudio", limits.GenerateAudio},
	} {
		if item.supported && protocolAllowsParam(channel, item.name) {
			parameters = append(parameters, item.name)
		}
	}
	return parameters
}

func resolveVideoParams(profile ProviderProfile, global, overrides VideoParams) (VideoParams, error) {
	limits, defaults := profile.Limits, profile.Defaults
	parameters := supportedVideoParams(profile, profile.Channel)
	durationAllowed := func(value int) bool {
		return slices.Contains(parameters, "duration") &&
			(value > 0 || profile.Provider == "ark" || profile.Provider == "byteplus") &&
			(limits.DurationMin == 0 || value >= limits.DurationMin) &&
			(limits.DurationMax == 0 || value <= limits.DurationMax) &&
			(len(limits.Durations) == 0 || slices.Contains(limits.Durations, value))
	}
	resolutionAllowed := func(value string) bool {
		return slices.Contains(parameters, "resolution") &&
			(len(limits.Resolutions) == 0 || slices.ContainsFunc(limits.Resolutions, func(allowed string) bool {
				return strings.EqualFold(allowed, value)
			}))
	}
	ratioAllowed := func(value string) bool {
		return slices.Contains(parameters, "aspectRatio") &&
			(len(limits.AspectRatios) == 0 || slices.Contains(limits.AspectRatios, value))
	}
	audioAllowed := slices.Contains(parameters, "generateAudio")
	if overrides.Duration != 0 && !durationAllowed(overrides.Duration) {
		return VideoParams{}, invalid("所选模型不支持该时长")
	}
	if overrides.Resolution != "" && !resolutionAllowed(overrides.Resolution) {
		return VideoParams{}, invalid("所选模型不支持该分辨率")
	}
	if overrides.AspectRatio != "" && !ratioAllowed(overrides.AspectRatio) {
		return VideoParams{}, invalid("所选模型不支持该画幅")
	}
	if overrides.GenerateAudio != nil && !audioAllowed {
		return VideoParams{}, invalid("所选模型不支持独立音频生成开关")
	}
	result := overrides
	if result.Duration == 0 {
		if defaults.Duration != 0 && durationAllowed(defaults.Duration) {
			result.Duration = defaults.Duration
		} else if global.Duration != 0 && durationAllowed(global.Duration) {
			result.Duration = global.Duration
		}
	}
	if result.Resolution == "" {
		if defaults.Resolution != "" && resolutionAllowed(defaults.Resolution) {
			result.Resolution = defaults.Resolution
		} else if global.Resolution != "" && resolutionAllowed(global.Resolution) {
			result.Resolution = global.Resolution
		}
	}
	if result.AspectRatio == "" {
		if defaults.AspectRatio != "" && ratioAllowed(defaults.AspectRatio) {
			result.AspectRatio = defaults.AspectRatio
		} else if global.AspectRatio != "" && ratioAllowed(global.AspectRatio) {
			result.AspectRatio = global.AspectRatio
		}
	}
	if result.GenerateAudio == nil && audioAllowed {
		result.GenerateAudio = defaults.GenerateAudio
		if result.GenerateAudio == nil {
			result.GenerateAudio = global.GenerateAudio
		}
	}
	return result, nil
}
