package velero

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// BackupSpecMap renders a protobuf BackupSpec in the shape of Velero's
// `Backup.spec` JSON (v1.18). Only what was set is emitted, so Velero's own
// defaults apply to the rest exactly as they do for the CLI.
func BackupSpecMap(s *pb.BackupSpec) map[string]any {
	out := map[string]any{}
	if s == nil {
		return out
	}
	if v := s.GetMetadataLabels(); len(v) > 0 {
		out["metadata"] = map[string]any{"labels": toAny(v)}
	}
	strs := func(key string, v []string) {
		if len(v) > 0 {
			out[key] = toAnySlice(v)
		}
	}
	strs("includedNamespaces", s.GetIncludedNamespaces())
	strs("excludedNamespaces", s.GetExcludedNamespaces())
	strs("includedResources", s.GetIncludedResources())
	strs("excludedResources", s.GetExcludedResources())
	strs("includedClusterScopedResources", s.GetIncludedClusterScopedResources())
	strs("excludedClusterScopedResources", s.GetExcludedClusterScopedResources())
	strs("includedNamespaceScopedResources", s.GetIncludedNamespaceScopedResources())
	strs("excludedNamespaceScopedResources", s.GetExcludedNamespaceScopedResources())
	if sel := labelSelectorMap(s.GetLabelSelector()); sel != nil {
		out["labelSelector"] = sel
	}
	var ors []any
	for _, sel := range s.GetOrLabelSelectors() {
		if m := labelSelectorMap(sel); m != nil {
			ors = append(ors, m)
		}
	}
	if len(ors) > 0 {
		out["orLabelSelectors"] = ors
	}
	if s.SnapshotVolumes != nil {
		out["snapshotVolumes"] = s.GetSnapshotVolumes()
	}
	duration(out, "ttl", s.GetTtl())
	if v := s.GetVolumeGroupSnapshotLabelKey(); v != "" {
		out["volumeGroupSnapshotLabelKey"] = v
	}
	if s.IncludeClusterResources != nil {
		out["includeClusterResources"] = s.GetIncludeClusterResources()
	}
	if h := hooksMap(s.GetHooks()); h != nil {
		out["hooks"] = h
	}
	if v := s.GetStorageLocation(); v != "" {
		out["storageLocation"] = v
	}
	strs("volumeSnapshotLocations", s.GetVolumeSnapshotLocations())
	if s.DefaultVolumesToFsBackup != nil {
		out["defaultVolumesToFsBackup"] = s.GetDefaultVolumesToFsBackup()
	}
	if v := s.GetOrderedResources(); len(v) > 0 {
		out["orderedResources"] = toAny(v)
	}
	duration(out, "csiSnapshotTimeout", s.GetCsiSnapshotTimeout())
	duration(out, "itemOperationTimeout", s.GetItemOperationTimeout())
	if r := s.GetResourcePolicy(); r != nil && r.GetName() != "" {
		out["resourcePolicy"] = map[string]any{"apiGroup": r.GetApiGroup(), "kind": r.GetKind(), "name": r.GetName()}
	}
	if s.SnapshotMoveData != nil {
		out["snapshotMoveData"] = s.GetSnapshotMoveData()
	}
	if v := s.GetDataMover(); v != "" {
		out["datamover"] = v
	}
	if u := s.GetUploaderConfig(); u != nil && u.GetParallelFilesUpload() > 0 {
		out["uploaderConfig"] = map[string]any{"parallelFilesUpload": int64(u.GetParallelFilesUpload())}
	}
	return out
}

func toAnySlice(in []string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

func duration(out map[string]any, key string, d *durationpb.Duration) {
	if d != nil && d.AsDuration() != 0 {
		out[key] = d.AsDuration().String()
	}
}

func labelSelectorMap(s *pb.LabelSelector) map[string]any {
	if s == nil || (len(s.GetMatchLabels()) == 0 && len(s.GetMatchExpressions()) == 0) {
		return nil
	}
	out := map[string]any{}
	if v := s.GetMatchLabels(); len(v) > 0 {
		out["matchLabels"] = toAny(v)
	}
	var exprs []any
	for _, e := range s.GetMatchExpressions() {
		m := map[string]any{"key": e.GetKey(), "operator": e.GetOperator()}
		if len(e.GetValues()) > 0 {
			m["values"] = toAnySlice(e.GetValues())
		}
		exprs = append(exprs, m)
	}
	if len(exprs) > 0 {
		out["matchExpressions"] = exprs
	}
	return out
}

func hooksMap(h *pb.BackupHooks) map[string]any {
	if h == nil || len(h.GetResources()) == 0 {
		return nil
	}
	var resources []any
	for _, r := range h.GetResources() {
		m := map[string]any{"name": r.GetName()}
		for key, v := range map[string][]string{
			"includedNamespaces": r.GetIncludedNamespaces(), "excludedNamespaces": r.GetExcludedNamespaces(),
			"includedResources": r.GetIncludedResources(), "excludedResources": r.GetExcludedResources(),
		} {
			if len(v) > 0 {
				m[key] = toAnySlice(v)
			}
		}
		if sel := labelSelectorMap(r.GetLabelSelector()); sel != nil {
			m["labelSelector"] = sel
		}
		for key, hooks := range map[string][]*pb.ExecHook{"pre": r.GetPre(), "post": r.GetPost()} {
			var list []any
			for _, e := range hooks {
				exec := map[string]any{"command": toAnySlice(e.GetCommand())}
				if e.GetContainer() != "" {
					exec["container"] = e.GetContainer()
				}
				switch e.GetOnError() {
				case pb.HookErrorMode_HOOK_ERROR_MODE_CONTINUE:
					exec["onError"] = "Continue"
				case pb.HookErrorMode_HOOK_ERROR_MODE_FAIL:
					exec["onError"] = "Fail"
				}
				duration(exec, "timeout", e.GetTimeout())
				list = append(list, map[string]any{"exec": exec})
			}
			if len(list) > 0 {
				m[key] = list
			}
		}
		resources = append(resources, m)
	}
	return map[string]any{"resources": resources}
}

// ---------------------------------------------------------------------------
// Strict validation (PLAN.md §5.2): the advanced escape hatch is merged onto the
// generated spec and the result is checked against the shape of Velero's
// BackupSpec. A field Velero does not have is rejected, never dropped, so a typo
// cannot silently produce a backup that is not what the operator asked for.

type kind int

const (
	kString kind = iota
	kBool
	kInt
	kDuration
	kStringList
	kStringMap
	kObject
	kObjectList
	// kAny is a value the agent does not look inside (an embedded Kubernetes container).
	kAny
)

type field struct {
	kind   kind
	fields map[string]field // for kObject and kObjectList
}

var selectorField = field{kind: kObject, fields: map[string]field{
	"matchLabels": {kind: kStringMap},
	"matchExpressions": {kind: kObjectList, fields: map[string]field{
		"key": {kind: kString}, "operator": {kind: kString}, "values": {kind: kStringList},
	}},
}}

var execHooks = field{kind: kObjectList, fields: map[string]field{
	"exec": {kind: kObject, fields: map[string]field{
		"container": {kind: kString}, "command": {kind: kStringList},
		"onError": {kind: kString}, "timeout": {kind: kDuration},
	}},
}}

// backupSpecShape is Velero v1.18's `BackupSpec`.
var backupSpecShape = map[string]field{
	"metadata":                         {kind: kObject, fields: map[string]field{"labels": {kind: kStringMap}}},
	"includedNamespaces":               {kind: kStringList},
	"excludedNamespaces":               {kind: kStringList},
	"includedResources":                {kind: kStringList},
	"excludedResources":                {kind: kStringList},
	"includedClusterScopedResources":   {kind: kStringList},
	"excludedClusterScopedResources":   {kind: kStringList},
	"includedNamespaceScopedResources": {kind: kStringList},
	"excludedNamespaceScopedResources": {kind: kStringList},
	"labelSelector":                    selectorField,
	"orLabelSelectors":                 {kind: kObjectList, fields: selectorField.fields},
	"snapshotVolumes":                  {kind: kBool},
	"ttl":                              {kind: kDuration},
	"volumeGroupSnapshotLabelKey":      {kind: kString},
	"includeClusterResources":          {kind: kBool},
	"hooks": {kind: kObject, fields: map[string]field{"resources": {kind: kObjectList, fields: map[string]field{
		"name": {kind: kString}, "includedNamespaces": {kind: kStringList}, "excludedNamespaces": {kind: kStringList},
		"includedResources": {kind: kStringList}, "excludedResources": {kind: kStringList},
		"labelSelector": selectorField, "pre": execHooks, "post": execHooks,
	}}}},
	"storageLocation":          {kind: kString},
	"volumeSnapshotLocations":  {kind: kStringList},
	"defaultVolumesToFsBackup": {kind: kBool},
	"orderedResources":         {kind: kStringMap},
	"csiSnapshotTimeout":       {kind: kDuration},
	"itemOperationTimeout":     {kind: kDuration},
	"resourcePolicy": {kind: kObject, fields: map[string]field{
		"apiGroup": {kind: kString}, "kind": {kind: kString}, "name": {kind: kString},
	}},
	"snapshotMoveData": {kind: kBool},
	"datamover":        {kind: kString},
	"uploaderConfig":   {kind: kObject, fields: map[string]field{"parallelFilesUpload": {kind: kInt}}},
}

// ErrInvalidSpec carries every problem found, each with the path it was found at.
type ErrInvalidSpec struct{ Problems []string }

func (e *ErrInvalidSpec) Error() string {
	return "the backup spec is not valid: " + strings.Join(e.Problems, "; ")
}

const maxProblems = 10

// specKind is a kind of Velero spec the advanced escape hatch may extend.
type specKind struct {
	label string
	shape map[string]field
}

var (
	backupKind  = specKind{label: "Backup", shape: backupSpecShape}
	restoreKind = specKind{label: "Restore", shape: restoreSpecShape}
)

// ValidateBackupSpec checks a Velero-shaped spec against BackupSpec.
func ValidateBackupSpec(spec map[string]any) error { return validateSpec(backupKind, spec) }

func validateSpec(kind specKind, spec map[string]any) error {
	var problems []string
	validateObject("spec", spec, kind.shape, kind.label, &problems)
	if len(problems) == 0 {
		return nil
	}
	sort.Strings(problems)
	if len(problems) > maxProblems {
		problems = append(problems[:maxProblems], fmt.Sprintf("and %d more", len(problems)-maxProblems))
	}
	return &ErrInvalidSpec{Problems: problems}
}

func validateObject(path string, obj map[string]any, shape map[string]field, label string, problems *[]string) {
	for key, value := range obj {
		f, known := shape[key]
		if !known {
			*problems = append(*problems, fmt.Sprintf("%s.%s is not a field of a Velero %s spec", path, key, label))
			continue
		}
		validateValue(path+"."+key, value, f, label, problems)
	}
}

func validateValue(path string, value any, f field, label string, problems *[]string) {
	bad := func(want string) { *problems = append(*problems, fmt.Sprintf("%s must be %s", path, want)) }
	switch f.kind {
	case kString:
		if _, ok := value.(string); !ok {
			bad("a string")
		}
	case kBool:
		if _, ok := value.(bool); !ok {
			bad("true or false")
		}
	case kInt:
		switch n := value.(type) {
		case int64:
			if n < 0 {
				bad("zero or more")
			}
		case float64:
			if n != float64(int64(n)) || n < 0 {
				bad("a whole number, zero or more")
			}
		default:
			bad("a whole number")
		}
	case kDuration:
		s, ok := value.(string)
		if !ok {
			bad(`a duration such as "720h"`)
			return
		}
		if d, err := time.ParseDuration(s); err != nil || d < 0 {
			bad(`a duration such as "720h"`)
		}
	case kAny:
		if value == nil {
			bad("a value")
		}
	case kStringList:
		list, ok := value.([]any)
		if !ok {
			bad("a list of strings")
			return
		}
		for i, item := range list {
			if _, ok := item.(string); !ok {
				*problems = append(*problems, fmt.Sprintf("%s[%d] must be a string", path, i))
			}
		}
	case kStringMap:
		m, ok := value.(map[string]any)
		if !ok {
			bad("a map of strings")
			return
		}
		for k, item := range m {
			if _, ok := item.(string); !ok {
				*problems = append(*problems, fmt.Sprintf("%s.%s must be a string", path, k))
			}
		}
	case kObject:
		m, ok := value.(map[string]any)
		if !ok {
			bad("an object")
			return
		}
		validateObject(path, m, f.fields, label, problems)
	case kObjectList:
		list, ok := value.([]any)
		if !ok {
			bad("a list")
			return
		}
		for i, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				*problems = append(*problems, fmt.Sprintf("%s[%d] must be an object", path, i))
				continue
			}
			validateObject(fmt.Sprintf("%s[%d]", path, i), m, f.fields, label, problems)
		}
	}
}

// MaxAdvancedSpecBytes bounds the escape hatch; a spec has no business being larger.
const MaxAdvancedSpecBytes = 256 * 1024

// ApplyAdvanced merges the JSON object `raw` onto `spec` (objects merge key by
// key, anything else replaces) and validates the result. An empty `raw` changes
// nothing but the result is still validated.
func ApplyAdvanced(spec map[string]any, raw []byte) (map[string]any, error) {
	return applyAdvanced(backupKind, spec, raw)
}

// ApplyAdvancedRestore is [ApplyAdvanced] for a Restore spec.
func ApplyAdvancedRestore(spec map[string]any, raw []byte) (map[string]any, error) {
	return applyAdvanced(restoreKind, spec, raw)
}

func applyAdvanced(kind specKind, spec map[string]any, raw []byte) (map[string]any, error) {
	if len(raw) > MaxAdvancedSpecBytes {
		return nil, &ErrInvalidSpec{Problems: []string{"advanced_spec_json is too large"}}
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		var extra map[string]any
		dec := json.NewDecoder(bytes.NewReader(raw))
		if err := dec.Decode(&extra); err != nil || extra == nil {
			return nil, &ErrInvalidSpec{Problems: []string{"advanced_spec_json must be a JSON object"}}
		}
		if dec.More() {
			return nil, &ErrInvalidSpec{Problems: []string{"advanced_spec_json must be a single JSON object"}}
		}
		spec = merge(spec, extra)
	}
	if err := validateSpec(kind, spec); err != nil {
		var invalid *ErrInvalidSpec
		if errors.As(err, &invalid) {
			return nil, invalid
		}
		return nil, err
	}
	return spec, nil
}

func merge(base, over map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(over))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		if o, ok := v.(map[string]any); ok {
			if b, ok := out[k].(map[string]any); ok {
				out[k] = merge(b, o)
				continue
			}
		}
		out[k] = v
	}
	return out
}
