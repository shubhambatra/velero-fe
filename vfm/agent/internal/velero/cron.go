package velero

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ValidateCron checks a schedule expression the way Velero reads it: the standard
// five-field form (minute hour day-of-month month day-of-week), the descriptors
// `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly` and `@every <duration>`.
// A schedule Velero cannot parse ends in `FailedValidation` and never runs, so the
// agent says so now.
func ValidateCron(expr string) error {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return fmt.Errorf("a cron expression is required")
	}
	if strings.HasPrefix(expr, "@") {
		switch expr {
		case "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly":
			return nil
		}
		if rest, ok := strings.CutPrefix(expr, "@every "); ok {
			d, err := time.ParseDuration(strings.TrimSpace(rest))
			if err != nil || d < time.Second {
				return fmt.Errorf("@every needs a duration of at least one second, such as \"@every 6h\"")
			}
			return nil
		}
		return fmt.Errorf("unknown descriptor %q", expr)
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return fmt.Errorf("a cron expression has five fields (minute hour day-of-month month day-of-week), found %d", len(fields))
	}
	limits := []struct {
		name     string
		lo, hi   int
		names    map[string]int
		allowAny bool
	}{
		{"minute", 0, 59, nil, false},
		{"hour", 0, 23, nil, false},
		{"day of month", 1, 31, nil, true},
		{"month", 1, 12, map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}, false},
		{"day of week", 0, 6, map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}, true},
	}
	for i, f := range fields {
		l := limits[i]
		if err := validateCronField(f, l.lo, l.hi, l.names, l.allowAny); err != nil {
			return fmt.Errorf("%s: %w", l.name, err)
		}
	}
	return nil
}

func validateCronField(field string, lo, hi int, names map[string]int, allowAny bool) error {
	for _, part := range strings.Split(field, ",") {
		if part == "" {
			return fmt.Errorf("empty list item in %q", field)
		}
		rng, step, hasStep := strings.Cut(part, "/")
		if hasStep {
			n, err := strconv.Atoi(step)
			if err != nil || n < 1 {
				return fmt.Errorf("step %q must be a positive number", step)
			}
		}
		switch {
		case rng == "*" || (allowAny && rng == "?"):
		default:
			a, b, isRange := strings.Cut(rng, "-")
			x, err := cronValue(a, lo, hi, names)
			if err != nil {
				return err
			}
			if isRange {
				y, err := cronValue(b, lo, hi, names)
				if err != nil {
					return err
				}
				if y < x {
					return fmt.Errorf("range %q runs backwards", rng)
				}
			}
		}
	}
	return nil
}

func cronValue(text string, lo, hi int, names map[string]int) (int, error) {
	if n, ok := names[strings.ToLower(text)]; ok {
		return n, nil
	}
	n, err := strconv.Atoi(text)
	if err != nil {
		return 0, fmt.Errorf("%q is not a number or a name", text)
	}
	if n < lo || n > hi {
		return 0, fmt.Errorf("%d is outside %d–%d", n, lo, hi)
	}
	return n, nil
}
