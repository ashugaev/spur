package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type identityError struct{ marker string }

func (e *identityError) Error() string { return e.marker }

const missingIdentity = "SPUR_LOGIN_IDENTITY_MISSING"
const duplicateIdentity = "SPUR_LOGIN_IDENTITY_DUPLICATE"
const changedIdentity = "SPUR_LOGIN_IDENTITY_CHANGED"

type providerIdentity struct {
	Provider       string
	OrganizationID string
	AccountID      string
}

func validatedIdentity(auth *coreauth.Auth) (providerIdentity, error) {
	var identity providerIdentity
	identity.Provider = auth.Provider
	accountID, _ := auth.Metadata["account_id"].(string)
	switch provider(auth.Provider) {
	case claude:
		identity.OrganizationID, _ = auth.Metadata["organization_uuid"].(string)
		identity.AccountID, _ = auth.Metadata["account_uuid"].(string)
		if strings.TrimSpace(identity.OrganizationID) == "" {
			return identity, &identityError{missingIdentity}
		}
	case codex:
		identity.AccountID = accountID
	default:
		return identity, &identityError{missingIdentity}
	}
	if strings.TrimSpace(identity.AccountID) == "" {
		return identity, &identityError{missingIdentity}
	}
	return identity, nil
}

func hydrateCodexIdentity(auth *coreauth.Auth) error {
	if provider(auth.Provider) != codex {
		return nil
	}
	if auth.Storage == nil {
		return &identityError{missingIdentity}
	}
	// AccountID comes from the SDK's exchanged OAuth token storage, not a JWT parser.
	raw, err := json.Marshal(auth.Storage)
	if err != nil {
		return err
	}
	var storage struct {
		AccountID string `json:"account_id"`
	}
	if err = json.Unmarshal(raw, &storage); err != nil {
		return err
	}
	if strings.TrimSpace(storage.AccountID) == "" {
		return &identityError{missingIdentity}
	}
	auth.Metadata["account_id"] = storage.AccountID
	return nil
}

func validateProfileIdentity(ctx context.Context, store coreauth.Store, auth *coreauth.Auth, id string) error {
	identity, err := validatedIdentity(auth)
	if err != nil {
		return err
	}
	stored, err := store.List(ctx)
	if err != nil {
		return errors.New("could not inspect saved account identities")
	}
	for _, previous := range stored {
		if previous.Provider != auth.Provider {
			continue
		}
		previousIdentity, err := validatedIdentity(previous)
		if err != nil {
			continue
		}
		if previous.ID == authFileID(id) {
			if previousIdentity != identity {
				return &identityError{changedIdentity}
			}
		} else if previousIdentity == identity {
			return &identityError{duplicateIdentity}
		}
	}
	return nil
}
