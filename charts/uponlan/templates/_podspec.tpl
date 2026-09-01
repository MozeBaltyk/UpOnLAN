{{- /* Shared pod spec used by both the Pod (podman play kube) and the
       Deployment (real K8s) wrappers. `.Values.deployAs` switches the
       podman-only bits: hostPort bindings and the emptyDir `path` extension.
       See pod.yaml / deployment.yaml. */ -}}
{{- define "uponlan.podspec" -}}
containers:
  - name: webapp
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    env:
      - name: MENU_VERSION
        value: "{{ .Values.menuVersion }}"
      - name: ENDPOINT_URL
        value: "{{ .Values.endpoint }}"
      - name: NGINX_PORT
        value: "{{ .Values.nginxPort }}"
      - name: WEB_APP_PORT
        value: "{{ .Values.webAppPort }}"
      - name: HTTPS_PORT
        value: "{{ .Values.httpsPort }}"
      - name: WEBAPP_HTTPS_PORT
        value: "{{ .Values.webAppHttpsPort }}"
      - name: TFTPD_OPTS
        value: "{{ .Values.tftpdOpts }}"
    volumeMounts:
      - name: uponlan-config
        mountPath: /config
      - name: uponlan-assets
        mountPath: /assets
      - name: uponlan-menu
        mountPath: /menu
      - name: uponlan-logs
        mountPath: /logs
      {{- if .Values.libvirt.enabled }}
      - name: libvirt-sock
        mountPath: /var/run/libvirt/libvirt-sock
      {{- end }}
    ports:
      - name: nginx
        containerPort: {{ .Values.nginxPort }}
        {{- if eq .Values.deployAs "Pod" }}
        hostPort: {{ .Values.nginxPort }}
        {{- end }}
      # Webapp listener is internal-only: the nginx TLS proxy reverse-proxies
      # to 127.0.0.1:WEB_APP_PORT in the same container, so no hostPort here.
      - name: webapp
        containerPort: {{ .Values.webAppPort }}
      - name: nginx-https
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
  # so config/assets/menu/logs survive `play kube --replace`. Deployment mode:
  # plain emptyDir (ephemeral) — a real cluster should swap these for hostPath
  # or a PVC if persistence matters.
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
  {{- if .Values.libvirt.enabled }}
  - name: libvirt-sock
    hostPath:
      path: {{ .Values.libvirt.socketPath }}
  {{- end }}
{{- end -}}
