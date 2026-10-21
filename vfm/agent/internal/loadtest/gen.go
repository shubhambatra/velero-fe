package loadtest

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// GenConfig shapes one simulated cluster.
type GenConfig struct {
	Seed       uint64
	Index      int
	VeleroObjs int
	Pods       int
	Nodes      int
	Namespaces int
}

// object is the compact state of one thing in the simulated cluster. The JSON the server
// receives is rendered from it each time (a snapshot of 200 clusters would otherwise hold
// hundreds of megabytes of identical text), and is deterministic in `seed`, so the same
// object always renders the same size.
type object struct {
	kind     pb.ResourceKind
	ns, name string
	uid      string
	rv       int
	phase    string
	seed     uint64
	created  time.Time
	schedule string
	node     string
	owner    string
	restarts int
	ctrs     int
	message  string
}

func (o *object) key() string { return fmt.Sprintf("%d/%s/%s", o.kind, o.ns, o.name) }

// Inventory is a simulated cluster's state, changed over time the way a real one is.
type Inventory struct {
	mu         sync.Mutex
	cfg        GenConfig
	rng        *rand.Rand
	objs       map[string]*object
	order      []string // insertion order, so a snapshot is stable
	namespaces []string
	pods       []string // keys, for churn
	inProgress []string
	seq        int
}

// Velero namespace of the simulated installation.
const veleroNamespace = "velero"

// NewInventory builds a cluster of the configured size.
func NewInventory(cfg GenConfig, now time.Time) *Inventory {
	inv := &Inventory{
		cfg:  cfg,
		rng:  rand.New(rand.NewPCG(cfg.Seed, uint64(cfg.Index)+1)), //nolint:gosec // simulation, not security
		objs: map[string]*object{},
	}
	inv.namespaces = append(inv.namespaces, veleroNamespace)
	for i := 1; i < cfg.Namespaces; i++ {
		inv.namespaces = append(inv.namespaces, fmt.Sprintf("ns-%03d", i))
	}
	for _, ns := range inv.namespaces {
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_NAMESPACE, name: ns, phase: "Active", created: now.Add(-30 * 24 * time.Hour)})
	}
	for i := 1; i <= cfg.Nodes; i++ {
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_NODE, name: fmt.Sprintf("node-%02d", i), phase: "Ready", created: now.Add(-90 * 24 * time.Hour)})
	}
	inv.populateVelero(now)
	for range cfg.Pods {
		inv.newPod(now)
	}
	for i := 0; i < cfg.Pods/5; i++ {
		ns := inv.namespaces[1+inv.rng.IntN(len(inv.namespaces)-1)]
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM, ns: ns, name: fmt.Sprintf("data-%04d", i), phase: "Bound", created: now.Add(-20 * 24 * time.Hour)})
	}
	for i := 0; i < 8; i++ {
		inv.newWarning(now)
	}
	return inv
}

// VeleroCounts splits n Velero objects over the kinds in the proportions of a real
// installation: 60 % backups, 10 % restores, 5 % schedules, 15 % pod volume backups,
// 1 % locations, and the rest repositories, snapshot locations and uploads.
func VeleroCounts(n int) map[pb.ResourceKind]int {
	if n <= 0 {
		return map[pb.ResourceKind]int{}
	}
	c := map[pb.ResourceKind]int{
		pb.ResourceKind_RESOURCE_KIND_RESTORE:                 n / 10,
		pb.ResourceKind_RESOURCE_KIND_SCHEDULE:                max(1, n/20),
		pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP:       n * 15 / 100,
		pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION: max(1, n/100),
	}
	used := 0
	for _, v := range c {
		used += v
	}
	backups := n * 60 / 100
	rest := max(0, n-used-backups)
	c[pb.ResourceKind_RESOURCE_KIND_BACKUP] = backups
	c[pb.ResourceKind_RESOURCE_KIND_BACKUP_REPOSITORY] = rest / 2
	c[pb.ResourceKind_RESOURCE_KIND_DATA_UPLOAD] = rest - rest/2 - rest/6
	c[pb.ResourceKind_RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION] = rest / 6
	total := 0
	for _, v := range c {
		total += v
	}
	c[pb.ResourceKind_RESOURCE_KIND_BACKUP] += n - total
	return c
}

func (inv *Inventory) add(o *object) {
	inv.seq++
	if o.uid == "" {
		o.uid = fmt.Sprintf("uid-%d-%d", inv.cfg.Index, inv.seq)
	}
	if o.rv == 0 {
		o.rv = 1
	}
	if o.seed == 0 {
		o.seed = inv.rng.Uint64() | 1
	}
	inv.objs[o.key()] = o
	inv.order = append(inv.order, o.key())
}

func (inv *Inventory) populateVelero(now time.Time) {
	counts := VeleroCounts(inv.cfg.VeleroObjs)
	pick := func(xs []string) string { return xs[inv.rng.IntN(len(xs))] }
	schedules := []string{}
	for i := 0; i < counts[pb.ResourceKind_RESOURCE_KIND_SCHEDULE]; i++ {
		name := fmt.Sprintf("sched-%02d", i)
		schedules = append(schedules, name)
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_SCHEDULE, ns: veleroNamespace, name: name, phase: "Enabled", created: now.Add(-60 * 24 * time.Hour), schedule: name})
	}
	for i := 0; i < counts[pb.ResourceKind_RESOURCE_KIND_BACKUP]; i++ {
		o := &object{kind: pb.ResourceKind_RESOURCE_KIND_BACKUP, ns: veleroNamespace, name: fmt.Sprintf("bk-%04d", i), phase: inv.backupPhase(),
			created: now.Add(-time.Duration(1+inv.rng.IntN(30*24*60)) * time.Minute)}
		if len(schedules) > 0 && inv.rng.Float64() < 0.7 {
			o.schedule = pick(schedules)
		}
		inv.add(o)
		if o.phase == "InProgress" {
			inv.inProgress = append(inv.inProgress, o.key())
		}
	}
	for i := 0; i < counts[pb.ResourceKind_RESOURCE_KIND_RESTORE]; i++ {
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_RESTORE, ns: veleroNamespace, name: fmt.Sprintf("rs-%04d", i), phase: pick([]string{"Completed", "Completed", "Completed", "PartiallyFailed", "Failed"}),
			created: now.Add(-time.Duration(1+inv.rng.IntN(20*24*60)) * time.Minute)})
	}
	for i := 0; i < counts[pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP]; i++ {
		inv.add(&object{kind: pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP, ns: veleroNamespace, name: fmt.Sprintf("pvb-%04d", i), phase: "Completed",
			created: now.Add(-time.Duration(1+inv.rng.IntN(30*24*60)) * time.Minute)})
	}
	for _, k := range []struct {
		kind   pb.ResourceKind
		prefix string
		phase  string
	}{
		{pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION, "bsl", "Available"},
		{pb.ResourceKind_RESOURCE_KIND_BACKUP_REPOSITORY, "repo", "Ready"},
		{pb.ResourceKind_RESOURCE_KIND_DATA_UPLOAD, "du", "Completed"},
		{pb.ResourceKind_RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION, "vsl", "Available"},
	} {
		for i := 0; i < counts[k.kind]; i++ {
			name := fmt.Sprintf("%s-%03d", k.prefix, i)
			if k.kind == pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION && i == 0 {
				name = "default"
			}
			inv.add(&object{kind: k.kind, ns: veleroNamespace, name: name, phase: k.phase, created: now.Add(-90 * 24 * time.Hour)})
		}
	}
}

func (inv *Inventory) backupPhase() string {
	r := inv.rng.Float64()
	switch {
	case r < 0.85:
		return "Completed"
	case r < 0.90:
		return "PartiallyFailed"
	case r < 0.95:
		return "Failed"
	default:
		return "InProgress"
	}
}

func (inv *Inventory) newPod(now time.Time) *object {
	return inv.newPodIn(inv.namespaces[1+inv.rng.IntN(len(inv.namespaces)-1)], now)
}

func (inv *Inventory) newPodIn(ns string, now time.Time) *object {
	inv.seq++
	phase := "Running"
	switch r := inv.rng.Float64(); {
	case r > 0.97:
		phase = "Failed"
	case r > 0.94:
		phase = "Succeeded"
	case r > 0.91:
		phase = "Pending"
	}
	o := &object{
		kind: pb.ResourceKind_RESOURCE_KIND_POD, ns: ns,
		name:  fmt.Sprintf("app-%d-%06d-%s", inv.rng.IntN(40), inv.seq, randSuffix(inv.rng)),
		phase: phase, created: now.Add(-time.Duration(1+inv.rng.IntN(7*24*60)) * time.Minute),
		node: fmt.Sprintf("node-%02d", 1+inv.rng.IntN(max(1, inv.cfg.Nodes))), ctrs: 1 + inv.rng.IntN(3),
		restarts: inv.rng.IntN(3),
	}
	o.owner = fmt.Sprintf("app-%d-%s", inv.rng.IntN(40), randSuffix(inv.rng))
	inv.add(o)
	inv.pods = append(inv.pods, o.key())
	return o
}

func (inv *Inventory) newWarning(now time.Time) *object {
	ns := inv.namespaces[1+inv.rng.IntN(len(inv.namespaces)-1)]
	inv.seq++
	o := &object{kind: pb.ResourceKind_RESOURCE_KIND_EVENT, ns: ns, name: fmt.Sprintf("evt-%06d", inv.seq), phase: "Warning",
		created: now, message: pickOf(inv.rng, []string{"Back-off restarting failed container", "Failed to pull image", "0/20 nodes are available: insufficient memory", "Readiness probe failed"})}
	inv.add(o)
	return o
}

func randSuffix(r *rand.Rand) string {
	const chars = "bcdfghjklmnpqrstvwxz2456789"
	b := make([]byte, 5)
	for i := range b {
		b[i] = chars[r.IntN(len(chars))]
	}
	return string(b)
}

func pickOf(r *rand.Rand, xs []string) string { return xs[r.IntN(len(xs))] }

// ObjectCount is how many objects the cluster holds.
func (inv *Inventory) ObjectCount() int {
	inv.mu.Lock()
	defer inv.mu.Unlock()
	return len(inv.objs)
}

// PodCount is how many pods the cluster holds.
func (inv *Inventory) PodCount() int {
	inv.mu.Lock()
	defer inv.mu.Unlock()
	return len(inv.pods)
}

// Namespaces lists the cluster's namespaces.
func (inv *Inventory) Namespaces() []string {
	inv.mu.Lock()
	defer inv.mu.Unlock()
	return append([]string(nil), inv.namespaces...)
}

// Items renders the state for a snapshot. When `scoped`, pods are included only for the
// namespaces `inScope` accepts, as a real agent does past its pod threshold.
func (inv *Inventory) Items(now time.Time, scoped bool, inScope func(string) bool) []*pb.ResourceItem {
	inv.mu.Lock()
	snapshot := make([]*object, 0, len(inv.order))
	for _, k := range inv.order {
		if o, ok := inv.objs[k]; ok {
			if scoped && o.kind == pb.ResourceKind_RESOURCE_KIND_POD && !inScope(o.ns) {
				continue
			}
			c := *o
			snapshot = append(snapshot, &c)
		}
	}
	inv.mu.Unlock()
	items := make([]*pb.ResourceItem, 0, len(snapshot))
	for _, o := range snapshot {
		items = append(items, render(o, now))
	}
	return items
}

// Mutate makes one change of the kind a live cluster sees: a backup starting or
// finishing, a pod restarting, flapping or being replaced, a new warning. It returns
// the events a real agent would report. `scoped` and `inScope` keep pod churn out of
// namespaces the control plane has not asked about.
func (inv *Inventory) Mutate(now time.Time, scoped bool, inScope func(string) bool) []*pb.ResourceEvent {
	inv.mu.Lock()
	defer inv.mu.Unlock()
	upsert := func(o *object) *pb.ResourceEvent {
		o.rv++
		return &pb.ResourceEvent{Type: pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT, Item: render(o, now)}
	}
	r := inv.rng.Float64()
	switch {
	case r < 0.35: // backups
		if len(inv.inProgress) > 0 && inv.rng.Float64() < 0.6 {
			i := inv.rng.IntN(len(inv.inProgress))
			o := inv.objs[inv.inProgress[i]]
			inv.inProgress = append(inv.inProgress[:i], inv.inProgress[i+1:]...)
			if o != nil {
				o.phase = pickOf(inv.rng, []string{"Completed", "Completed", "Completed", "Completed", "PartiallyFailed", "Failed"})
				return []*pb.ResourceEvent{upsert(o)}
			}
		}
		inv.seq++
		o := &object{kind: pb.ResourceKind_RESOURCE_KIND_BACKUP, ns: veleroNamespace, name: fmt.Sprintf("bk-live-%06d", inv.seq), phase: "InProgress", created: now}
		inv.add(o)
		inv.inProgress = append(inv.inProgress, o.key())
		return []*pb.ResourceEvent{upsert(o)}
	case r < 0.45: // restores
		inv.seq++
		o := &object{kind: pb.ResourceKind_RESOURCE_KIND_RESTORE, ns: veleroNamespace, name: fmt.Sprintf("rs-live-%06d", inv.seq), phase: "Completed", created: now}
		inv.add(o)
		return []*pb.ResourceEvent{upsert(o)}
	case r < 0.55: // a new warning
		return []*pb.ResourceEvent{upsert(inv.newWarning(now))}
	default: // pod churn
		for range 8 {
			if len(inv.pods) == 0 {
				break
			}
			i := inv.rng.IntN(len(inv.pods))
			o := inv.objs[inv.pods[i]]
			if o == nil || (scoped && !inScope(o.ns)) {
				continue
			}
			switch inv.rng.IntN(3) {
			case 0:
				o.restarts++
				return []*pb.ResourceEvent{upsert(o)}
			case 1:
				if o.phase == "Running" {
					o.phase = "Pending"
				} else {
					o.phase = "Running"
				}
				return []*pb.ResourceEvent{upsert(o)}
			default: // replaced
				delete(inv.objs, o.key())
				inv.pods = append(inv.pods[:i], inv.pods[i+1:]...)
				inv.compactOrder()
				tomb := &pb.ResourceEvent{Type: pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE, Item: &pb.ResourceItem{
					Kind: o.kind, Namespace: o.ns, Name: o.name, Uid: o.uid}}
				fresh := inv.newPodIn(o.ns, now) // the replacement lives where the old one did
				return []*pb.ResourceEvent{tomb, upsert(fresh)}
			}
		}
		// Nothing in scope to churn: a warning is always possible.
		return []*pb.ResourceEvent{upsert(inv.newWarning(now))}
	}
}

// compactOrder drops keys of removed objects now and then, so `order` does not grow without bound.
func (inv *Inventory) compactOrder() {
	if len(inv.order) < 2*len(inv.objs)+64 {
		return
	}
	kept := inv.order[:0]
	seen := map[string]bool{}
	for _, k := range inv.order {
		if _, ok := inv.objs[k]; ok && !seen[k] {
			kept = append(kept, k)
			seen[k] = true
		}
	}
	inv.order = kept
}

// ---------------------------------------------------------------- rendering

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func render(o *object, now time.Time) *pb.ResourceItem {
	meta := map[string]any{"name": o.name, "uid": o.uid, "creationTimestamp": rfc(o.created)}
	if o.ns != "" {
		meta["namespace"] = o.ns
	}
	var obj map[string]any
	apiVersion, kind := "velero.io/v1", ""
	switch o.kind {
	case pb.ResourceKind_RESOURCE_KIND_NAMESPACE:
		apiVersion, kind = "v1", "Namespace"
		meta["labels"] = map[string]any{"kubernetes.io/metadata.name": o.name}
		obj = map[string]any{"status": map[string]any{"phase": o.phase}}
	case pb.ResourceKind_RESOURCE_KIND_NODE:
		apiVersion, kind = "v1", "Node"
		meta["labels"] = map[string]any{"kubernetes.io/hostname": o.name, "node-role.kubernetes.io/worker": ""}
		obj = map[string]any{
			"spec": map[string]any{},
			"status": map[string]any{
				"phase":       o.phase,
				"allocatable": map[string]any{"cpu": "8", "memory": "32Gi", "pods": "110"},
				"nodeInfo":    map[string]any{"kubeletVersion": "v1.31.2"},
				"conditions":  []any{map[string]any{"type": "Ready", "status": "True", "reason": "KubeletReady"}},
			},
		}
	case pb.ResourceKind_RESOURCE_KIND_POD:
		apiVersion, kind = "v1", "Pod"
		statuses := make([]any, 0, o.ctrs)
		for i := 0; i < o.ctrs; i++ {
			statuses = append(statuses, map[string]any{
				"name": fmt.Sprintf("c%d", i), "image": fmt.Sprintf("registry.example.com/team/app-%d:1.%d.0", int(o.seed%40), i),
				"ready": o.phase == "Running", "state": map[string]string{"Running": "running", "Pending": "waiting"}[o.phase], "reason": "",
				"restartCount": o.restarts, "lastTerminationReason": "", "init": false,
			})
		}
		ready := 0
		if o.phase == "Running" {
			ready = o.ctrs
		}
		obj = map[string]any{
			"spec": map[string]any{"nodeName": o.node, "owner": map[string]any{"kind": "ReplicaSet", "name": o.owner}},
			"status": map[string]any{
				"phase": o.phase, "containerStatuses": statuses, "readyCount": ready, "restartCount": o.restarts * o.ctrs,
				"containerCount": o.ctrs, "startTimestamp": rfc(o.created),
			},
		}
	case pb.ResourceKind_RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM:
		apiVersion, kind = "v1", "PersistentVolumeClaim"
		obj = map[string]any{
			"spec":   map[string]any{"storageClassName": "fast", "volumeName": "pv-" + o.name},
			"status": map[string]any{"phase": o.phase, "capacity": map[string]any{"storage": "10Gi"}},
		}
	case pb.ResourceKind_RESOURCE_KIND_EVENT:
		apiVersion, kind = "v1", "Event"
		obj = map[string]any{"status": map[string]any{
			"phase": o.phase, "reason": "BackOff", "message": o.message, "count": 3 + int(o.seed%20), "startTimestamp": rfc(now.Add(-time.Duration(o.seed%1800) * time.Second)),
			"involvedObject": map[string]any{"kind": "Pod", "name": "app-0", "namespace": o.ns, "apiVersion": "v1"},
		}}
	default:
		kind = veleroKind(o.kind)
		obj = veleroBody(o, meta, now)
	}
	obj["apiVersion"], obj["kind"], obj["metadata"] = apiVersion, kind, meta
	raw, err := json.Marshal(obj)
	if err != nil {
		raw = []byte("{}")
	}
	if isVelero(o.kind) {
		raw = padTo(obj, raw, 2048+int(o.seed%2048))
	}
	item := &pb.ResourceItem{
		Kind: o.kind, Namespace: o.ns, Name: o.name, Uid: o.uid,
		ResourceVersion: fmt.Sprintf("%d", o.rv), ObjectJson: raw,
		CreationTimestamp: timestamppb.New(o.created),
	}
	return item
}

func isVelero(k pb.ResourceKind) bool {
	switch k {
	case pb.ResourceKind_RESOURCE_KIND_NAMESPACE, pb.ResourceKind_RESOURCE_KIND_NODE, pb.ResourceKind_RESOURCE_KIND_POD,
		pb.ResourceKind_RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM, pb.ResourceKind_RESOURCE_KIND_EVENT:
		return false
	}
	return true
}

func veleroKind(k pb.ResourceKind) string {
	return map[pb.ResourceKind]string{
		pb.ResourceKind_RESOURCE_KIND_BACKUP:                   "Backup",
		pb.ResourceKind_RESOURCE_KIND_RESTORE:                  "Restore",
		pb.ResourceKind_RESOURCE_KIND_SCHEDULE:                 "Schedule",
		pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION:  "BackupStorageLocation",
		pb.ResourceKind_RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION: "VolumeSnapshotLocation",
		pb.ResourceKind_RESOURCE_KIND_BACKUP_REPOSITORY:        "BackupRepository",
		pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP:        "PodVolumeBackup",
		pb.ResourceKind_RESOURCE_KIND_DATA_UPLOAD:              "DataUpload",
	}[k]
}

func veleroBody(o *object, meta map[string]any, now time.Time) map[string]any {
	labels := map[string]any{"app.kubernetes.io/managed-by": "velero", "team": fmt.Sprintf("team-%d", o.seed%12), "env": pickEnv(o.seed)}
	if o.schedule != "" {
		labels["velero.io/schedule-name"] = o.schedule
	}
	meta["labels"] = labels
	started := o.created
	done := started.Add(time.Duration(30+o.seed%600) * time.Second)
	included := make([]string, 0, 12)
	for i := uint64(0); i < 4+o.seed%9; i++ {
		included = append(included, fmt.Sprintf("ns-%03d", 1+(o.seed+i*7)%59))
	}
	status := map[string]any{"phase": o.phase, "startTimestamp": rfc(started), "version": 1}
	switch o.phase {
	case "Completed", "PartiallyFailed", "Failed", "Ready", "Available":
		status["completionTimestamp"] = rfc(done)
		status["progress"] = map[string]any{"totalItems": 800 + int(o.seed%400), "itemsBackedUp": 800 + int(o.seed%400)}
		status["formatVersion"] = "1.1.0"
	case "InProgress":
		status["progress"] = map[string]any{"totalItems": 800, "itemsBackedUp": int(o.seed % 700)}
	}
	if o.kind == pb.ResourceKind_RESOURCE_KIND_BACKUP {
		status["expiration"] = rfc(started.Add(30 * 24 * time.Hour))
		status["warnings"], status["errors"] = int(o.seed%5), 0
		if o.phase == "Failed" {
			status["failureReason"] = "BackupStorageLocation \"default\" is unavailable"
			status["errors"] = 1
		}
		status["volumeSnapshotsAttempted"] = int(o.seed % 6)
		status["volumeSnapshotsCompleted"] = int(o.seed % 6)
	}
	var spec map[string]any
	switch o.kind {
	case pb.ResourceKind_RESOURCE_KIND_BACKUP:
		spec = map[string]any{"storageLocation": "default", "ttl": "720h0m0s", "includedNamespaces": included, "excludedResources": []string{"events", "events.events.k8s.io"}, "snapshotVolumes": true,
			"defaultVolumesToFsBackup": o.seed%2 == 0, "metadata": map[string]any{"labels": map[string]any{"owner": "load-test"}}}
	case pb.ResourceKind_RESOURCE_KIND_RESTORE:
		spec = map[string]any{"backupName": fmt.Sprintf("bk-%04d", o.seed%100), "includedNamespaces": included, "existingResourcePolicy": "none", "restorePVs": true}
	case pb.ResourceKind_RESOURCE_KIND_SCHEDULE:
		spec = map[string]any{"schedule": "0 2 * * *", "template": map[string]any{"storageLocation": "default", "ttl": "720h0m0s", "includedNamespaces": included}}
		status["lastBackup"] = rfc(now.Add(-time.Duration(o.seed%20) * time.Hour))
	case pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION:
		spec = map[string]any{"provider": "aws", "default": true, "accessMode": "ReadWrite", "objectStorage": map[string]any{"bucket": "velero-backups", "prefix": "cluster"}, "config": map[string]any{"region": "eu-west-1"}}
		status["lastValidationTime"] = rfc(now)
	case pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP:
		spec = map[string]any{"node": "node-01", "pod": map[string]any{"kind": "Pod", "namespace": "ns-001", "name": "app-0"}, "volume": "data", "backupStorageLocation": "default"}
	default:
		spec = map[string]any{"backupStorageLocation": "default", "repositoryType": "kopia", "volumeNamespace": "ns-001"}
	}
	return map[string]any{"spec": spec, "status": status}
}

func pickEnv(seed uint64) string { return []string{"prod", "staging", "dev"}[seed%3] }

// padTo grows status.message until the encoded object is about `target` bytes, so the
// objects have the size of real ones (2 to 4 KB) without being identical.
func padTo(obj map[string]any, raw []byte, target int) []byte {
	if len(raw) >= target {
		return raw
	}
	status, _ := obj["status"].(map[string]any)
	if status == nil {
		return raw
	}
	status["message"] = strings.Repeat("velero item operation detail; ", (target-len(raw))/30+1)[:target-len(raw)-14]
	out, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return out
}
