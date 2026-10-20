{{- define "vfm-cp.name" -}}vfm-control-plane{{- end -}}

{{- define "vfm-cp.fullname" -}}{{ .Release.Name }}-control-plane{{- end -}}

{{- define "vfm-cp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vfm-cp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "vfm-cp.labels" -}}
{{ include "vfm-cp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "vfm-cp.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
