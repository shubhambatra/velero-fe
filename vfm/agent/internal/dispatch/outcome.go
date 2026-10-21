package dispatch

import (
	"encoding/json"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// detail is the op-specific part of a result that is worth replaying. Only the
// small, structured results are kept; anything else is replayed without detail,
// which the control plane treats as "succeeded, nothing further to record".
type detail struct {
	ServerStatus *statusDetail  `json:"server_status,omitempty"`
	Created      *createdDetail `json:"created,omitempty"`
}

type statusDetail struct {
	Version string         `json:"version"`
	Plugins []pluginDetail `json:"plugins"`
}

type pluginDetail struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type createdDetail struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	UID  string `json:"uid"`
}

func outcomeOf(r *pb.CommandResult) Outcome {
	o := Outcome{
		OK:           r.GetOk(),
		ErrorCode:    int32(r.GetErrorCode()),
		ErrorMessage: r.GetErrorMessage(),
		FinishedAt:   r.GetFinishedAt().AsTime(),
	}
	var d detail
	switch x := r.GetDetail().(type) {
	case *pb.CommandResult_ServerStatus:
		s := &statusDetail{Version: x.ServerStatus.GetServerVersion()}
		for _, p := range x.ServerStatus.GetPlugins() {
			s.Plugins = append(s.Plugins, pluginDetail{Name: p.GetName(), Kind: p.GetKind()})
		}
		d.ServerStatus = s
	case *pb.CommandResult_Created:
		d.Created = &createdDetail{Kind: x.Created.GetKind(), Name: x.Created.GetName(), UID: x.Created.GetUid()}
	}
	if d.ServerStatus != nil || d.Created != nil {
		if raw, err := json.Marshal(d); err == nil {
			o.Detail = raw
		}
	}
	return o
}

// resultMessage rebuilds a result from a remembered outcome.
func resultMessage(id string, o Outcome) *pb.AgentMessage {
	r := &pb.CommandResult{
		CommandId:    id,
		Ok:           o.OK,
		ErrorCode:    pb.ErrorCode(o.ErrorCode),
		ErrorMessage: o.ErrorMessage,
		FinishedAt:   timestamppb.New(o.FinishedAt),
	}
	var d detail
	if len(o.Detail) > 0 && json.Unmarshal(o.Detail, &d) == nil {
		switch {
		case d.ServerStatus != nil:
			s := &pb.ServerStatus{ServerVersion: d.ServerStatus.Version}
			for _, p := range d.ServerStatus.Plugins {
				s.Plugins = append(s.Plugins, &pb.PluginInfo{Name: p.Name, Kind: p.Kind})
			}
			r.Detail = &pb.CommandResult_ServerStatus{ServerStatus: s}
		case d.Created != nil:
			r.Detail = &pb.CommandResult_Created{Created: &pb.CreatedObject{
				Kind: d.Created.Kind, Name: d.Created.Name, Uid: d.Created.UID,
			}}
		}
	}
	return &pb.AgentMessage{Payload: &pb.AgentMessage_Result{Result: r}}
}
