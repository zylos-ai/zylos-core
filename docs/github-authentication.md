# GitHub Authentication for Component Operations

`zylos add`, `zylos upgrade`, and upgrade checks read release tags and component
metadata from GitHub. Public API requests are limited per source IP, so CI,
Kubernetes, and shared E2E runners should provide a token:

```bash
export GITHUB_TOKEN="<read-only-token>"
zylos upgrade --all --check
```

Use a read-only fine-grained token with access only to the repositories that
Zylos must read. Store it in the platform's secret manager; do not commit it to
the repository or print it in job logs.

## Resolution and fallback behavior

Credentials are resolved in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token`

When a token is available, GitHub API tag and raw-file requests authenticate on
the first attempt. If GitHub rejects that request (for example, because the
token cannot access a public organization), Zylos retries the public endpoint.
Without a token, it uses the public endpoint directly.

GitHub archive downloads remain public-first because codeload traffic does not
consume the REST API quota. Private-repository downloads still fall back to the
authenticated tarball API.

## CI and E2E

GitHub Actions can use its short-lived job token:

```yaml
permissions:
  contents: read

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test # Replace with the project's E2E command when different.
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

For other CI systems, create a masked secret named `GITHUB_TOKEN` and expose it
only to the install, upgrade, or E2E step. Avoid placing the token directly in a
shell command, where tracing can reveal it.

## Kubernetes

Create a Secret through your normal secret-management workflow, then reference
it from the Zylos container:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: zylos-github
type: Opaque
stringData:
  token: <read-only-token>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zylos
spec:
  template:
    spec:
      containers:
        - name: zylos
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: zylos-github
                  key: token
```

For production, prefer an external secret controller or an encrypted manifest
over committing the `Secret` example with a real value.
