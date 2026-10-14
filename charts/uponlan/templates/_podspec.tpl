{{- /* Shared pod spec used by both the Pod (podman play kube) and the
       Deployment (real K8s) wrappers. `.Values.deployAs` switches the
       podman-only bits: hostPort bindings and the emptyDir `path` extension.
       See pod.yaml / deployment.yaml. */ -}}
{{- define "uponlan.podspec" -}}
{{- $p := .Values.okd.persistence -}}
{{- $anyOkdPvc := or (not (empty $p.configClaim)) (not (empty $p.assetsClaim)) (not (empty $p.menuClaim)) (not (empty $p.logsClaim)) -}}
{{- $allOkdPvcs := and (not (empty $p.configClaim)) (not (empty $p.assetsClaim)) (not (empty $p.menuClaim)) (not (empty $p.logsClaim)) -}}
{{- if and (empty .Values.webappAuth.existingSecret) (ne (empty .Values.webappAuth.user) (empty .Values.webappAuth.password)) -}}
{{- fail "webappAuth.user and webappAuth.password must both be set" -}}
{{- end }}
{{- if and $anyOkdPvc (not $allOkdPvcs) -}}
{{- fail "OKD persistence requires all four config/assets/menu/logs persistentVolumeClaims" -}}
{{- end }}
{{- if and (eq .Values.deployAs "Deployment") $allOkdPvcs (ne (int .Values.replicas) 1) -}}
{{- fail "OKD persistent generation requires replicas=1" -}}
{{- end }}
{{- if and (eq .Values.deployAs "Deployment") (not (empty .Values.okd.pullSecret.hostPath)) -}}
{{- fail "okd.pullSecret.hostPath is supported only with deployAs=Pod" -}}
{{- end }}
{{- if and (eq .Values.deployAs "Pod") (not (empty .Values.okd.pullSecret.existingSecret)) -}}
{{- fail "okd.pullSecret.existingSecret is supported only with deployAs=Deployment" -}}
{{- end }}
containers:
  - name: webapp
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    env:
      - name: MENU_VERSION
        value: "{{ .Values.menuVersion }}"
      - name: ENDPOINT_URL
        value: "{{ .Values.endpoint }}"
      - name: WEB_APP_PORT
        value: "{{ .Values.webAppPort }}"
      - name: HTTPS_PORT
        value: "{{ .Values.httpsPort }}"
      - name: WEBAPP_HTTPS_PORT
        value: "{{ .Values.webAppHttpsPort }}"
      - name: TFTPD_OPTS
        value: "{{ .Values.tftpdOpts }}"
      - name: OKD_PUBLIC_BASE_URL
        value: {{ .Values.okd.publicBaseUrl | quote }}
      - name: OKD_PERSISTENCE_READY
        value: {{ or (eq .Values.deployAs "Pod") $allOkdPvcs | quote }}
      - name: OKD_RETENTION_DAYS
        value: {{ .Values.okd.retentionDays | quote }}
      {{- if .Values.webappAuth.existingSecret }}
      - name: WEBAPP_USER
        valueFrom:
          secretKeyRef:
            name: {{ .Values.webappAuth.existingSecret | quote }}
            key: {{ .Values.webappAuth.usernameKey | quote }}
      - name: WEBAPP_PASS
        valueFrom:
          secretKeyRef:
            name: {{ .Values.webappAuth.existingSecret | quote }}
            key: {{ .Values.webappAuth.passwordKey | quote }}
      {{- else if and .Values.webappAuth.user .Values.webappAuth.password }}
      - name: WEBAPP_USER
        value: {{ .Values.webappAuth.user | quote }}
      - name: WEBAPP_PASS
        value: {{ .Values.webappAuth.password | quote }}
      {{- end }}
    volumeMounts:
      - name: uponlan-config
        mountPath: /config
      - name: uponlan-assets
        mountPath: /assets
      - name: uponlan-menu
        mountPath: /menu
      - name: uponlan-logs
        mountPath: /logs
      {{- if and (eq .Values.deployAs "Pod") .Values.okd.pullSecret.hostPath }}
      - name: okd-pull-secret
        mountPath: /run/secrets/okd-pull-secret
        readOnly: true
      {{- else if and (eq .Values.deployAs "Deployment") .Values.okd.pullSecret.existingSecret }}
      - name: okd-pull-secret
        mountPath: /run/secrets/okd-pull-secret
        subPath: okd-pull-secret
        readOnly: true
      {{- end }}
      {{- if .Values.libvirt.enabled }}
      - name: libvirt-sock
        mountPath: /var/run/libvirt/libvirt-sock
      {{- end }}
    ports:
      # Webapp listener is internal-only: the nginx TLS proxy reverse-proxies
      # to 127.0.0.1:WEB_APP_PORT in the same container, so no hostPort here.
      - name: webapp
        containerPort: {{ .Values.webAppPort }}
      # Assets over TLS (the sole asset listener — no plain-HTTP port).
      - name: nginx
        containerPort: {{ .Values.httpsPort }}
        {{- if eq .Values.deployAs "Pod" }}
        hostPort: {{ .Values.httpsPort }}
        {{- end }}
      - name: webapp-https
        containerPort: {{ .Values.webAppHttpsPort }}
        {{- if eq .Values.deployAs "Pod" }}
        hostPort: {{ .Values.webAppHttpsPort }}
        {{- end }}
      - name: tftp
        containerPort: 69
        protocol: UDP
        {{- if eq .Values.deployAs "Pod" }}
        hostPort: 69
        {{- end }}
volumes:
  # Pod mode: `emptyDir.path` is a podman extension (host-dir-backed emptyDir)
  # so config/assets/menu/logs survive `play kube --replace`. Deployment mode
  # uses all four OKD PVCs together, or preserves the prior ephemeral emptyDirs.
  {{- if eq .Values.deployAs "Pod" }}
  - name: uponlan-config
    emptyDir:
      path: ./config
  - name: uponlan-assets
    emptyDir:
      path: ./assets
  - name: uponlan-menu
    emptyDir:
      path: ./menu
  - name: uponlan-logs
    emptyDir:
      path: ./logs
  {{- else if $allOkdPvcs }}
  - name: uponlan-config
    persistentVolumeClaim:
      claimName: {{ .Values.okd.persistence.configClaim | quote }}
  - name: uponlan-assets
    persistentVolumeClaim:
      claimName: {{ .Values.okd.persistence.assetsClaim | quote }}
  - name: uponlan-menu
    persistentVolumeClaim:
      claimName: {{ .Values.okd.persistence.menuClaim | quote }}
  - name: uponlan-logs
    persistentVolumeClaim:
      claimName: {{ .Values.okd.persistence.logsClaim | quote }}
  {{- else }}
  - name: uponlan-config
    emptyDir: {}
  - name: uponlan-assets
    emptyDir: {}
  - name: uponlan-menu
    emptyDir: {}
  - name: uponlan-logs
    emptyDir: {}
  {{- end }}
  {{- if and (eq .Values.deployAs "Pod") .Values.okd.pullSecret.hostPath }}
  - name: okd-pull-secret
    hostPath:
      path: {{ .Values.okd.pullSecret.hostPath | quote }}
      type: File
  {{- else if and (eq .Values.deployAs "Deployment") .Values.okd.pullSecret.existingSecret }}
  - name: okd-pull-secret
    secret:
      secretName: {{ .Values.okd.pullSecret.existingSecret | quote }}
      defaultMode: 0440
      items:
        - key: {{ .Values.okd.pullSecret.key | quote }}
          path: okd-pull-secret
  {{- end }}
  {{- if .Values.libvirt.enabled }}
  - name: libvirt-sock
    hostPath:
      path: {{ .Values.libvirt.socketPath }}
  {{- end }}
{{- end -}}
