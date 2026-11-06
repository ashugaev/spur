package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func identityFixture(t *testing.T, id, organization, account string) *coreauth.Auth {
	t.Helper()
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"provider":"claude","metadata":{"type":"claude","email":"same@example.invalid","access_token":"fixture-token"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	auth.ID, auth.FileName = authFileID(id), authFileID(id)
	auth.Metadata["organization_uuid"], auth.Metadata["account_uuid"] = organization, account
	return &auth
}

func TestProviderIdentityDedupAndTenantIsolation(t *testing.T) {
	ctx := context.Background()
	store := tokenStore(t.TempDir())
	first := identityFixture(t, "first", "org-one", "user-one")
	if _, err := store.Save(ctx, first); err != nil {
		t.Fatal(err)
	}
	duplicate := identityFixture(t, "duplicate", "org-one", "user-one")
	var identityErr *identityError
	if err := validateProfileIdentity(ctx, store, duplicate, "duplicate"); !errors.As(err, &identityErr) || identityErr.marker != duplicateIdentity {
		t.Fatal("same tenant/account accepted in a second profile")
	}
	otherTenant := identityFixture(t, "other", "org-two", "user-one")
	if err := validateProfileIdentity(ctx, store, otherTenant, "other"); err != nil {
		t.Fatal("same email in another tenant was rejected")
	}
	relogin := identityFixture(t, "first", "org-one", "user-one")
	if err := validateProfileIdentity(ctx, store, relogin, "first"); err != nil {
		t.Fatal("same-profile reauthentication rejected")
	}
	changed := identityFixture(t, "first", "org-two", "user-one")
	if err := validateProfileIdentity(ctx, store, changed, "first"); !errors.As(err, &identityErr) || identityErr.marker != changedIdentity {
		t.Fatal("reauthentication silently redirected an existing profile")
	}
	stored, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Metadata["organization_uuid"] != "org-one" {
		t.Fatal("rejected identity modified saved credentials")
	}
}

func TestMissingIdentityCannotBecomeReady(t *testing.T) {
	for _, test := range []struct{ organization, account string }{{"", "user-one"}, {"org-one", ""}} {
		auth := identityFixture(t, "first", test.organization, test.account)
		if _, err := validatedIdentity(auth); err == nil {
			t.Fatal("incomplete tenant/account identity accepted")
		}
	}
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"provider":"codex","metadata":{"email":"same@example.invalid"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	if _, err := validatedIdentity(&auth); err == nil {
		t.Fatal("Codex email used as account identity")
	}
	auth.Metadata["account_id"] = "workspace-one"
	first, err := validatedIdentity(&auth)
	if err != nil {
		t.Fatal(err)
	}
	auth.Metadata["account_id"] = "workspace-two"
	second, err := validatedIdentity(&auth)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different Codex workspaces collapsed")
	}
}
