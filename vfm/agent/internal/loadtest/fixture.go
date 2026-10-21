package loadtest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// Fixture is what the provisioner (server/scripts/loadtest-provision.ts) writes: an
// organization with clusters waiting to be enrolled, an admin and some signed-in users.
type Fixture struct {
	APIBase           string           `json:"apiBase"`
	Gateway           string           `json:"gateway"`
	GatewayServerName string           `json:"gatewayServerName"`
	CAPEM             string           `json:"caPem"`
	OrgID             string           `json:"orgId"`
	AdminCookie       string           `json:"adminCookie"`
	AdminCSRF         string           `json:"adminCsrf"`
	Clusters          []FixtureCluster `json:"clusters"`
	Users             []FixtureUser    `json:"users"`
}

// FixtureCluster is one cluster to simulate. The token is single use.
type FixtureCluster struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	BootstrapToken string `json:"bootstrapToken"`
}

// FixtureUser is one virtual browser's login.
type FixtureUser struct {
	Email  string `json:"email"`
	Cookie string `json:"cookie"`
	CSRF   string `json:"csrf"`
}

// LoadFixture reads and checks a fixture file.
func LoadFixture(path string) (*Fixture, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // the operator names the file
	if err != nil {
		return nil, err
	}
	var f Fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("fixture is not JSON: %w", err)
	}
	return &f, f.Validate()
}

// Validate says what is missing.
func (f *Fixture) Validate() error {
	switch {
	case f.APIBase == "" || f.Gateway == "" || f.CAPEM == "" || f.OrgID == "":
		return errors.New("fixture needs apiBase, gateway, caPem and orgId")
	case f.AdminCookie == "":
		return errors.New("fixture needs adminCookie")
	case len(f.Clusters) == 0:
		return errors.New("fixture has no clusters")
	}
	return nil
}
