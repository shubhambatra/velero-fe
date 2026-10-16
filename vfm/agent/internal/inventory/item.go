package inventory

import (
	"encoding/json"
	"errors"
	"fmt"

	"google.golang.org/protobuf/types/known/timestamppb"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// MaxObjectBytes caps one object's JSON. Anything larger is skipped and logged,
// never truncated: a half object would be worse than a missing one.
const MaxObjectBytes = 256 * 1024

// ErrTooLarge means an object exceeded [MaxObjectBytes].
var ErrTooLarge = errors.New("object is too large to sync")

const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

// Item turns an object into its wire form.
//
// What is removed is deliberate. `managedFields` is large and says nothing a user
// wants. The last-applied annotation is a full second copy of the object and, for
// objects someone applied by hand, may carry whatever they pasted. The result is
// what the UI shows, so the agent decides here what leaves the cluster.
func Item(kind pb.ResourceKind, obj *unstructured.Unstructured) (*pb.ResourceItem, error) {
	clean := obj.DeepCopy()
	unstructured.RemoveNestedField(clean.Object, "metadata", "managedFields")
	if annotations := clean.GetAnnotations(); annotations != nil {
		delete(annotations, lastApplied)
		if len(annotations) == 0 {
			unstructured.RemoveNestedField(clean.Object, "metadata", "annotations")
		} else {
			clean.SetAnnotations(annotations)
		}
	}

	raw, err := json.Marshal(clean.Object)
	if err != nil {
		return nil, fmt.Errorf("encode %s/%s: %w", clean.GetNamespace(), clean.GetName(), err)
	}
	if len(raw) > MaxObjectBytes {
		return nil, fmt.Errorf("%w: %s/%s is %d bytes", ErrTooLarge, clean.GetNamespace(), clean.GetName(), len(raw))
	}

	item := &pb.ResourceItem{
		Kind:            kind,
		Namespace:       clean.GetNamespace(),
		Name:            clean.GetName(),
		Uid:             string(clean.GetUID()),
		ResourceVersion: clean.GetResourceVersion(),
		ObjectJson:      raw,
	}
	if ts := clean.GetCreationTimestamp(); !ts.IsZero() {
		item.CreationTimestamp = timestamppb.New(ts.Time)
	}
	return item, nil
}

// Tombstone identifies a deleted object; a DELETE needs no body.
func Tombstone(kind pb.ResourceKind, obj *unstructured.Unstructured) *pb.ResourceItem {
	return &pb.ResourceItem{
		Kind:      kind,
		Namespace: obj.GetNamespace(),
		Name:      obj.GetName(),
		Uid:       string(obj.GetUID()),
	}
}
