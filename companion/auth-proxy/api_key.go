package main

import (
	"context"
	"errors"
	"strings"
	"unicode"
)

// validAPIKey bounds a pasted API key: 8..512 bytes, no whitespace or control characters.
func validAPIKey(key string) bool {
	if len(key) < 8 || len(key) > 512 {
		return false
	}
	return strings.IndexFunc(key, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) < 0
}

// setAPIKey verifies and saves an API-key credential through the common commit sequence. The key is
// never logged or returned.
func (l *loginManager) setAPIKey(parent context.Context, id string, p provider, key string) (loginStatus, error) {
	if !validAPIKey(key) {
		return loginStatus{}, errors.New("invalid API key")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active != "" {
		return loginStatus{}, errors.New("another account sign-in is pending")
	}
	ctx, a := l.claim(parent, id, methodAPIKey, loginStatus{Stage: stageVerifying})
	staged := buildAPIKeyRecord(id, p, key)
	go func() { l.finish(id, a, l.commit(ctx, id, p, a, staged)) }()
	return a.status, nil
}
