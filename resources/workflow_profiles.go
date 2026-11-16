package resources

import "embed"

// WorkflowProfiles contains the fixed definitions shared by the Host and Studio kernel.
//
//go:embed workflow-profiles/*.json
var WorkflowProfiles embed.FS
