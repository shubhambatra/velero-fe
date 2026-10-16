package inventory

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

func timestampNow() *timestamppb.Timestamp { return timestamppb.New(time.Now()) }
