package policy

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

// FuzzParse: whatever bytes the ConfigMap holds, Parse never panics, and a policy it
// refuses is exactly Lockdown() — never a half-parsed, more permissive one.
func FuzzParse(f *testing.F) {
	// The right-to-left override, built at run time so that no source line hides text from a reader.
	rlo := string(rune(0x202e))
	for _, seed := range [][3]string{
		{"allowRestore", "false", ""},
		{"restoreDeniedNamespaces", "[kube-system, velero]", ""},
		{"restoreDeniedNamespaces", `["a","b"`, ""},
		{"restoreDeniedNamespaces", "[[[[,,,]]]", ""},
		{"logStreamDeniedNamespaces", strings.Repeat("a,", 5000), ""},
		{"logStreamDeniedNamespaces", strings.Repeat("x", 64), ""},
		{"readOnly", "\x00", ""},
		{"readOnly", "TRUE", ""},
		{"readOnly", "1e9999999", ""},
		{"allowRestor", "false", ""},
		{"allowBslWrite", "yes\n", "allowRestore"},
		{rlo + "allowRestore", rlo + "false", ""},
		{"restoreDeniedNamespaces", "kube-system\n- velero", "readOnly"},
		{"", "", ""},
	} {
		f.Add(seed[0], seed[1], seed[2])
	}
	f.Fuzz(func(t *testing.T, key, value, key2 string) {
		data := map[string]string{key: value}
		if key2 != "" {
			data[key2] = value
		}
		p, err := Parse(data)
		if err != nil {
			if !reflect.DeepEqual(p, Lockdown()) {
				t.Fatalf("a refused policy must be Lockdown, got %+v for %q", p, data)
			}
			return
		}
		// Accepted: every key was a known one, and lists hold only non-empty short names.
		for k := range data {
			switch k {
			case "allowRestore", "allowBslWrite", "allowLogStreaming", "readOnly", "restoreDeniedNamespaces", "logStreamDeniedNamespaces":
			default:
				t.Fatalf("accepted unknown key %q", k)
			}
		}
		for _, list := range [][]string{p.RestoreDeniedNamespaces, p.LogStreamDeniedNamespaces} {
			for _, item := range list {
				if item == "" || len(item) > 63 {
					t.Fatalf("list item %q", item)
				}
			}
		}
		// Reporting it never panics and never aliases the live slices.
		_ = p.Proto()
	})
}

// FuzzCheckRestoreScope: a restore the policy lets through must not be able to write
// into a protected namespace — including by a pattern (Velero accepts globs in the
// namespace filters) or by a name that is not a plain namespace.
func FuzzCheckRestoreScope(f *testing.F) {
	f.Add("kube-system", "kube-system", "", "", "", "")
	f.Add("kube-system", "kube-*", "", "", "", "")
	f.Add("kube-system", "kube-s?stem", "", "", "", "")
	f.Add("kube-system", "*", "", "", "", "")
	f.Add("kube-system", "", "", "app", "kube-system", "")
	f.Add("kube-system", "[k]ube-system", "", "", "", "")
	f.Add("kube-system", "{kube-system,x}", "", "", "", "")
	f.Add("kube-system", "kube-system\x00", "", "", "", "")
	f.Add("kube-system", "KUBE-SYSTEM", "", "", "", "")
	f.Add("kube-system", "app", "kube-*", "", "", "")
	f.Add("kube-system", "app", "", "kube-sy*", "kube-system", "")
	f.Fuzz(func(t *testing.T, denied, inc, exc, mapFrom, mapTo, inc2 string) {
		p := Default()
		p.RestoreDeniedNamespaces = []string{denied}
		included := []string{}
		if inc != "" {
			included = append(included, inc)
		}
		if inc2 != "" {
			included = append(included, inc2)
		}
		var excluded []string
		if exc != "" {
			excluded = []string{exc}
		}
		var mapping map[string]string
		if mapFrom != "" || mapTo != "" {
			mapping = map[string]string{mapFrom: mapTo}
		}
		if p.CheckRestoreScope(included, excluded, mapping) != nil {
			return
		}
		// Allowed. Nothing named may reach the protected namespace.
		reaches := func(pattern string) bool {
			if pattern == denied {
				return true
			}
			// Anything that is not a plain name could stand for several; only a plain,
			// different name is known not to be the protected one.
			return !plainName(pattern)
		}
		if len(included) == 0 && !slices.Contains(excluded, denied) {
			t.Fatalf("all namespaces without excluding %q was allowed", denied)
		}
		for _, in := range included {
			if reaches(in) {
				t.Fatalf("included %q can reach protected %q and was allowed", in, denied)
			}
		}
		for _, to := range mapping {
			if reaches(to) {
				t.Fatalf("mapping into %q (protected %q) was allowed", to, denied)
			}
		}
	})
}

// FuzzCheckLogSession: allowed implies streaming is on and the namespace is not listed.
func FuzzCheckLogSession(f *testing.F) {
	f.Add("kube-system", "kube-system")
	f.Add("*", "anything")
	f.Add("a", "a\x00")
	f.Fuzz(func(t *testing.T, denied, ns string) {
		p := Default()
		p.LogStreamDeniedNamespaces = []string{denied}
		if p.CheckLogSession(ns) == nil && (denied == "*" || denied == ns) {
			t.Fatalf("streaming %q was allowed although %q is denied", ns, denied)
		}
		p.AllowLogStreaming = false
		if p.CheckLogSession(ns) == nil {
			t.Fatal("streaming allowed while switched off")
		}
	})
}
