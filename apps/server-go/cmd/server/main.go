package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------- Presets ----------------

type Preset struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	AuthMode  string            `json:"authMode"`
	AuthKey   string            `json:"authKey"`
	AuthValue string            `json:"authValue"`
	UpdatedAt string            `json:"updatedAt"`
}

type PresetStore struct {
	mu      sync.Mutex
	path    string
	presets map[string]Preset
}

func NewPresetStore(path string) *PresetStore {
	return &PresetStore{path: path, presets: map[string]Preset{}}
}

func (s *PresetStore) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(filepath.Clean(s.path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var list []Preset
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}
	s.presets = map[string]Preset{}
	for _, p := range list {
		if p.ID != "" {
			s.presets[p.ID] = p
		}
	}
	return nil
}

func (s *PresetStore) List() []Preset {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Preset, 0, len(s.presets))
	for _, p := range s.presets {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *PresetStore) Upsert(p Preset) (Preset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if p.ID == "" {
		p.ID = fmt.Sprintf("p_%d", time.Now().UnixNano())
	}
	p.UpdatedAt = time.Now().Format(time.RFC3339Nano)
	if p.Headers == nil {
		p.Headers = map[string]string{}
	}
	s.presets[p.ID] = p

	list := make([]Preset, 0, len(s.presets))
	for _, v := range s.presets {
		list = append(list, v)
	}
	b, _ := json.MarshalIndent(list, "", "  ")
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return Preset{}, err
	}
	if err := os.WriteFile(s.path, b, 0o644); err != nil {
		return Preset{}, err
	}
	return p, nil
}

// ---------------- Auth (alpha) ----------------

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type Auth struct {
	mu       sync.Mutex
	sessions map[string]map[string]any
}

func NewAuth() *Auth {
	return &Auth{sessions: map[string]map[string]any{}}
}

func randToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "missing username"})
		return
	}
	tok := randToken()
	profile := map[string]any{"username": req.Username, "role": "alpha-tester"}
	a.mu.Lock()
	a.sessions[tok] = profile
	a.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "token": tok, "profile": profile})
}

func (a *Auth) me(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer"))
	if tok == "" {
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	a.mu.Lock()
	profile, ok := a.sessions[tok]
	a.mu.Unlock()
	writeJSON(w, map[string]any{"ok": ok, "profile": profile})
}

// ---------------- Proxy send ----------------

type SendRequest struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
}

type SendResponse struct {
	OK         bool              `json:"ok"`
	Error      string            `json:"error,omitempty"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	DurationMs int64             `json:"durationMs"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
}

func newHTTPClient() *http.Client {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   8 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	return &http.Client{
		Timeout:   0,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			return nil
		},
	}
}

func handleSend(client *http.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req SendRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		method := strings.ToUpper(strings.TrimSpace(req.Method))
		if method == "" {
			method = "GET"
		}
		raw := strings.TrimSpace(req.URL)
		if raw == "" || (!strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://")) {
			http.Error(w, "url must start with http:// or https://", http.StatusBadRequest)
			return
		}

		timeout := 25 * time.Second
		if req.TimeoutMs > 0 {
			timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		var body io.Reader
		if req.Body != "" && method != "GET" && method != "HEAD" {
			body = strings.NewReader(req.Body)
		}
		httpReq, err := http.NewRequestWithContext(ctx, method, raw, body)
		if err != nil {
			writeJSON(w, SendResponse{OK: false, Error: err.Error()})
			return
		}

		for k, v := range req.Headers {
			kk := strings.TrimSpace(k)
			if kk == "" {
				continue
			}
			httpReq.Header.Set(kk, v)
		}
		if httpReq.Header.Get("User-Agent") == "" {
			httpReq.Header.Set("User-Agent", "Stressless-win/0.1")
		}
		if req.Body != "" && httpReq.Header.Get("Content-Type") == "" && method != "GET" && method != "HEAD" {
			httpReq.Header.Set("Content-Type", "application/json")
		}

		start := time.Now()
		resp, err := client.Do(httpReq)
		dur := time.Since(start)

		if err != nil {
			writeJSON(w, SendResponse{OK: false, Error: err.Error(), DurationMs: dur.Milliseconds()})
			return
		}
		defer resp.Body.Close()

		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
		outHeaders := map[string]string{}
		for k, vv := range resp.Header {
			if len(vv) > 0 {
				outHeaders[k] = vv[0]
			}
		}

		writeJSON(w, SendResponse{
			OK:         true,
			Status:     resp.StatusCode,
			StatusText: resp.Status,
			DurationMs: dur.Milliseconds(),
			Headers:    outHeaders,
			Body:       string(b),
		})
	}
}

// ---------------- Discover (SSE) ----------------

type DiscoverRequest struct {
	Target string `json:"target"`
}

type DiscoverEvent struct {
	Kind    string            `json:"kind"`
	Message string            `json:"message"`
	Meta    map[string]string `json:"meta,omitempty"`
	Time    string            `json:"time"`
}

type sseClient struct{ ch chan []byte }

type DiscoverHub struct {
	mu      sync.Mutex
	clients map[*sseClient]struct{}
	running bool
	cancel  context.CancelFunc
}

func NewDiscoverHub() *DiscoverHub {
	return &DiscoverHub{clients: map[*sseClient]struct{}{}}
}

func (h *DiscoverHub) add(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	c := &sseClient{ch: make(chan []byte, 128)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	}()

	send := func(b []byte) {
		fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}
	send([]byte(`{"kind":"info","message":"connected","time":"` + time.Now().Format(time.RFC3339Nano) + `"}`))

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case b := <-c.ch:
			send(b)
		}
	}
}

func (h *DiscoverHub) broadcast(v any) {
	b, _ := json.Marshal(v)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.ch <- b:
		default:
		}
	}
}

func (h *DiscoverHub) start(w http.ResponseWriter, r *http.Request) {
	var req DiscoverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Target) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	if h.running {
		h.mu.Unlock()
		http.Error(w, "already running", http.StatusConflict)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.running = true
	h.cancel = cancel
	h.mu.Unlock()

	target := strings.TrimSpace(req.Target)

	go func() {
		defer func() {
			h.mu.Lock()
			h.running = false
			h.cancel = nil
			h.mu.Unlock()
			h.broadcast(DiscoverEvent{Kind: "info", Message: "discover_finished", Time: time.Now().Format(time.RFC3339Nano)})
		}()

		host := target
		if strings.Contains(target, "://") {
			u := strings.TrimPrefix(target, "http://")
			u = strings.TrimPrefix(u, "https://")
			host = strings.Split(u, "/")[0]
		}
		host = strings.TrimSpace(strings.TrimPrefix(host, "www."))

		h.broadcast(DiscoverEvent{Kind: "info", Message: "Discovering: " + host, Time: time.Now().Format(time.RFC3339Nano)})

		if host == "openai.com" {
			h.broadcast(DiscoverEvent{
				Kind:    "suggestion",
				Message: "Known domain: openai.com",
				Time:    time.Now().Format(time.RFC3339Nano),
				Meta: map[string]string{
					"docs_url":       "https://platform.openai.com/docs/api-reference/introduction",
					"api_base":       "https://api.openai.com/v1",
					"auth":           "bearer",
					"openapi_source": "github_repo:openai/openai-openapi",
				},
			})
			return
		}

		probes := []string{
			"https://" + host + "/openapi.json",
			"https://" + host + "/swagger.json",
			"https://" + host + "/docs",
		}

		client := newHTTPClient()
		for _, p := range probes {
			select {
			case <-ctx.Done():
				h.broadcast(DiscoverEvent{Kind: "warning", Message: "discover_cancelled", Time: time.Now().Format(time.RFC3339Nano)})
				return
			default:
			}

			h.broadcast(DiscoverEvent{Kind: "probe", Message: "GET " + p, Time: time.Now().Format(time.RFC3339Nano)})
			req2, _ := http.NewRequestWithContext(ctx, "GET", p, nil)
			req2.Header.Set("User-Agent", "Stressless-win-Discover/0.1")

			resp, err := client.Do(req2)
			if err != nil {
				h.broadcast(DiscoverEvent{Kind: "warning", Message: "fail: " + err.Error(), Time: time.Now().Format(time.RFC3339Nano)})
				continue
			}
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
			resp.Body.Close()

			ct := resp.Header.Get("Content-Type")
			h.broadcast(DiscoverEvent{Kind: "probe_result", Message: fmt.Sprintf("%d %s", resp.StatusCode, ct), Time: time.Now().Format(time.RFC3339Nano)})

			if strings.Contains(strings.ToLower(ct), "json") && bytes.Contains(b, []byte(`"openapi"`)) {
				h.broadcast(DiscoverEvent{Kind: "finding", Message: "Looks like OpenAPI", Time: time.Now().Format(time.RFC3339Nano), Meta: map[string]string{"openapi_url": p}})
				return
			}
		}
	}()

	writeJSON(w, map[string]any{"status": "started"})
}

func (h *DiscoverHub) stop(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.cancel != nil {
		h.cancel()
	}
	h.mu.Unlock()
	writeJSON(w, map[string]any{"status": "stopping"})
}

// ---------------- Static ----------------

func serveStatic(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	root := "web-dist"
	full := filepath.Join(root, filepath.Clean(path))

	if _, err := os.Stat(full); err == nil {
		http.ServeFile(w, r, full)
		return
	}
	http.NotFound(w, r)
}

// ---------------- Utilities ----------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	store := NewPresetStore("data/presets.json")
	_ = store.Load()
	client := newHTTPClient()
	hub := NewDiscoverHub()
	auth := NewAuth()

	mux := http.NewServeMux()

	mux.HandleFunc("/api/presets", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			writeJSON(w, store.List())
		case "POST":
			var p Preset
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			pp, err := store.Upsert(p)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true, "id": pp.ID})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/send", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleSend(client)(w, r)
	})

	mux.HandleFunc("/api/discover/events", hub.add)
	mux.HandleFunc("/api/discover/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.start(w, r)
	})
	mux.HandleFunc("/api/discover/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.stop(w, r)
	})

	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		auth.login(w, r)
	})
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		auth.me(w, r)
	})

	mux.HandleFunc("/", serveStatic)

	srv := &http.Server{Addr: ":8080", Handler: withCORS(mux), ReadTimeout: 20 * time.Second, WriteTimeout: 0}
	log.Println("Stressless-win backend on http://127.0.0.1:8080")
	log.Fatal(srv.ListenAndServe())
}
