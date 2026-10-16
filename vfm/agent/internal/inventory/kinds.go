// Package inventory keeps the control plane's picture of a cluster's Velero
// objects in step with the cluster (PLAN.md §5.3): a full snapshot on connect and
// on a timer, and debounced deltas in between.
//
// It watches through the dynamic client, so the agent does not link Velero's Go
// types. Velero objects are reported as the agent chooses to expose them: managed
// fields and last-applied annotations are stripped, and nothing is ever read from
// a Secret.
package inventory

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// Kind pairs a protocol kind with the resource that holds it.
type Kind struct {
	Proto pb.ResourceKind
	GVR   schema.GroupVersionResource
}

func (k Kind) String() string { return k.GVR.Resource + "." + k.GVR.Group }

var (
	v1       = schema.GroupVersion{Group: "velero.io", Version: "v1"}
	v2alpha1 = schema.GroupVersion{Group: "velero.io", Version: "v2alpha1"}
)

// VeleroKinds are the Velero kinds of PLAN.md §5.3. The data-mover kinds live in
// v2alpha1 and exist only on Velero versions that ship them.
var VeleroKinds = []Kind{
	{pb.ResourceKind_RESOURCE_KIND_BACKUP, v1.WithResource("backups")},
	{pb.ResourceKind_RESOURCE_KIND_RESTORE, v1.WithResource("restores")},
	{pb.ResourceKind_RESOURCE_KIND_SCHEDULE, v1.WithResource("schedules")},
	{pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION, v1.WithResource("backupstoragelocations")},
	{pb.ResourceKind_RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION, v1.WithResource("volumesnapshotlocations")},
	{pb.ResourceKind_RESOURCE_KIND_BACKUP_REPOSITORY, v1.WithResource("backuprepositories")},
	{pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP, v1.WithResource("podvolumebackups")},
	{pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_RESTORE, v1.WithResource("podvolumerestores")},
	{pb.ResourceKind_RESOURCE_KIND_DATA_UPLOAD, v2alpha1.WithResource("datauploads")},
	{pb.ResourceKind_RESOURCE_KIND_DATA_DOWNLOAD, v2alpha1.WithResource("datadownloads")},
	{pb.ResourceKind_RESOURCE_KIND_DELETE_BACKUP_REQUEST, v1.WithResource("deletebackuprequests")},
}

// Available returns the subset of kinds the cluster actually serves, so an older
// Velero without the data-mover kinds (or a cluster without Velero at all) is
// reported on honestly instead of failing every watch. "Not found" means absent;
// any other discovery failure is returned, because treating an outage as "this
// Velero has no backups" would empty the inventory.
func Available(ctx context.Context, disc discovery.DiscoveryInterface, kinds []Kind) ([]Kind, error) {
	served := map[schema.GroupVersion]map[string]bool{}
	var out []Kind
	for _, k := range kinds {
		gv := k.GVR.GroupVersion()
		if _, done := served[gv]; !done {
			list, err := disc.ServerResourcesForGroupVersion(gv.String())
			switch {
			case apierrors.IsNotFound(err):
				served[gv] = nil
			case err != nil:
				return nil, fmt.Errorf("discover %s: %w", gv, err)
			default:
				names := map[string]bool{}
				for _, r := range list.APIResources {
					names[r.Name] = true
				}
				served[gv] = names
			}
		}
		if served[gv][k.GVR.Resource] {
			out = append(out, k)
		}
	}
	return out, ctx.Err()
}
