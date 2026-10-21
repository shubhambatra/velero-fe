{{- define "vfm-agent.name" -}}vfm-agent{{- end -}}

{{- define "vfm-agent.labels" -}}
app.kubernetes.io/name: {{ include "vfm-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "vfm-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vfm-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "vfm-agent.image" -}}
{{ .Values.image.repository }}:{{ default .Chart.AppVersion .Values.image.tag }}
{{- end -}}

{{/* The names below are the agent's own defaults (agent/internal/config/product.go); the RBAC is written against them. */}}
{{- define "vfm-agent.credentialsSecret" -}}vfm-agent-credentials{{- end -}}
{{- define "vfm-agent.stateConfigMap" -}}vfm-agent-state{{- end -}}
{{- define "vfm-agent.policyConfigMap" -}}vfm-agent-policy{{- end -}}
{{- define "vfm-agent.leaseName" -}}vfm-agent{{- end -}}
