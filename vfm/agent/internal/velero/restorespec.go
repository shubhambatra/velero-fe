package velero

import (
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// RestoreSpecMap renders a protobuf RestoreSpec in the shape of Velero's
// `Restore.spec` JSON (v1.18). Only what was set is emitted.
func RestoreSpecMap(s *pb.RestoreSpec) map[string]any {
	out := map[string]any{}
	if s == nil {
		return out
	}
	str := func(key, v string) {
		if v != "" {
			out[key] = v
		}
	}
	strs := func(key string, v []string) {
		if len(v) > 0 {
			out[key] = toAnySlice(v)
		}
	}
	str("backupName", s.GetBackupName())
	str("scheduleName", s.GetScheduleName())
	strs("includedNamespaces", s.GetIncludedNamespaces())
	strs("excludedNamespaces", s.GetExcludedNamespaces())
	strs("includedResources", s.GetIncludedResources())
	strs("excludedResources", s.GetExcludedResources())
	if v := s.GetNamespaceMapping(); len(v) > 0 {
		out["namespaceMapping"] = toAny(v)
	}
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
	if s.RestorePvs != nil {
		out["restorePVs"] = s.GetRestorePvs()
	}
	if rs := s.GetRestoreStatus(); rs != nil && (len(rs.GetIncludedResources()) > 0 || len(rs.GetExcludedResources()) > 0) {
		status := map[string]any{}
		if v := rs.GetIncludedResources(); len(v) > 0 {
			status["includedResources"] = toAnySlice(v)
		}
		if v := rs.GetExcludedResources(); len(v) > 0 {
			status["excludedResources"] = toAnySlice(v)
		}
		out["restoreStatus"] = status
	}
	if s.PreserveNodePorts != nil {
		out["preserveNodePorts"] = s.GetPreserveNodePorts()
	}
	if s.IncludeClusterResources != nil {
		out["includeClusterResources"] = s.GetIncludeClusterResources()
	}
	switch s.GetExistingResourcePolicy() {
	case pb.ExistingResourcePolicy_EXISTING_RESOURCE_POLICY_NONE:
		out["existingResourcePolicy"] = "none"
	case pb.ExistingResourcePolicy_EXISTING_RESOURCE_POLICY_UPDATE:
		out["existingResourcePolicy"] = "update"
	}
	duration(out, "itemOperationTimeout", s.GetItemOperationTimeout())
	if r := s.GetResourceModifier(); r != nil && r.GetName() != "" {
		out["resourceModifier"] = map[string]any{"apiGroup": r.GetApiGroup(), "kind": r.GetKind(), "name": r.GetName()}
	}
	if u := s.GetUploaderConfig(); u != nil && (u.WriteSparseFiles != nil || u.GetParallelFilesDownload() > 0) {
		cfg := map[string]any{}
		if u.WriteSparseFiles != nil {
			cfg["writeSparseFiles"] = u.GetWriteSparseFiles()
		}
		if u.GetParallelFilesDownload() > 0 {
			cfg["parallelFilesDownload"] = int64(u.GetParallelFilesDownload())
		}
		out["uploaderConfig"] = cfg
	}
	return out
}

// restoreSpecShape is Velero v1.18's `RestoreSpec`. Hooks are reachable only
// through the advanced escape hatch.
var restoreSpecShape = map[string]field{
	"backupName":         {kind: kString},
	"scheduleName":       {kind: kString},
	"includedNamespaces": {kind: kStringList},
	"excludedNamespaces": {kind: kStringList},
	"includedResources":  {kind: kStringList},
	"excludedResources":  {kind: kStringList},
	"namespaceMapping":   {kind: kStringMap},
	"labelSelector":      selectorField,
	"orLabelSelectors":   {kind: kObjectList, fields: selectorField.fields},
	"restorePVs":         {kind: kBool},
	"restoreStatus": {kind: kObject, fields: map[string]field{
		"includedResources": {kind: kStringList}, "excludedResources": {kind: kStringList},
	}},
	"preserveNodePorts":       {kind: kBool},
	"includeClusterResources": {kind: kBool},
	"hooks": {kind: kObject, fields: map[string]field{"resources": {kind: kObjectList, fields: map[string]field{
		"name": {kind: kString}, "includedNamespaces": {kind: kStringList}, "excludedNamespaces": {kind: kStringList},
		"includedResources": {kind: kStringList}, "excludedResources": {kind: kStringList},
		"labelSelector": selectorField,
		"postHooks": {kind: kObjectList, fields: map[string]field{
			"exec": {kind: kObject, fields: map[string]field{
				"container": {kind: kString}, "command": {kind: kStringList}, "onError": {kind: kString},
				"execTimeout": {kind: kDuration}, "waitTimeout": {kind: kDuration}, "waitForReady": {kind: kBool},
			}},
			"init": {kind: kObject, fields: map[string]field{
				"initContainers": {kind: kAny},
				"timeout":        {kind: kDuration},
			}},
		}},
	}}}},
	"existingResourcePolicy": {kind: kString},
	"itemOperationTimeout":   {kind: kDuration},
	"resourceModifier": {kind: kObject, fields: map[string]field{
		"apiGroup": {kind: kString}, "kind": {kind: kString}, "name": {kind: kString},
	}},
	"uploaderConfig": {kind: kObject, fields: map[string]field{
		"writeSparseFiles": {kind: kBool}, "parallelFilesDownload": {kind: kInt},
	}},
}
