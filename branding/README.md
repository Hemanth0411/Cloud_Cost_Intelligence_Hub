# branding/ — the Cognito managed login page

Sign-in leaves the app. Passwordless email OTP requires Cognito's
**managed login**, and the classic hosted UI cannot do OTP, so the
redirect to
`costhub-dev-997916278551.auth.us-east-1.amazoncognito.com` is not
removable — it can only be made to look like CostHub. Everything in this
directory exists to do that.

`do.sh ensure_login_branding` applies it on every `./do.sh up <env>`.

## Why the files live here and not in `frontend/public`

The managed login page is served by AWS, not by our frontend. It cannot
reference a URL: `CreateManagedLoginBranding` / `UpdateManagedLoginBranding`
take image **files**, base64-encoded into the request body, and a JSON
settings document. So these are deployment inputs for `do.sh`, in the same
category as `terraform/env/*.tfvars` — not web assets, and nothing in the
Next.js build reads them. Keeping them beside `do.sh`, which is their only
consumer, is what makes the page reproducible from a clean checkout:
nobody has to re-derive a logo from the branding editor by hand.

They are **not** in `terraform/`, because none of this is Terraform.
`aws_cognito_managed_login_branding` does not exist in the pinned provider
(aws 5.100.0 — 14 cognito resources, not that one).

## The files

| File | What it is |
|---|---|
| `managed-login-settings.json` | The `--settings` document: every colour, border radius and layout switch. |
| `costhub-header-logo.png` | `PAGE_HEADER_LOGO` — the wordmark on the ateneo header bar. |
| `costhub-favicon.ico` | `FAVICON_ICO` — the browser tab icon during the redirect. |
| `costhub-email-graphic.svg` | `EMAIL_GRAPHIC` — the icon on the "enter the code we emailed you" screen. |
| `make-assets.py` | Redraws the PNG and the ICO. |
| `preview-*.png` | Review-only renders. Never uploaded. |

## Where the colours came from

`frontend/src/app/globals.css`, converted from HSL to the `RRGGBBAA` hex
the API wants. Nothing is invented here:

| Role | Token | Hex |
|---|---|---|
| Page background | `--background` (cream) | `e8e1ce` |
| Header bar, primary button | `--primary` / `--sidebar` (ateneo) | `004567` |
| Form card | `--card` | `f9f7f1` |
| Focus ring, link hover, logo accent | `--ring` (bronze) | `c98b27` |
| Headings | `--foreground` | `202232` |
| Body and placeholder text | `--muted-foreground` (slate) | `5c6082` |

Border radii match the app's `--radius` (12px containers, 10px for the
`rounded-md` buttons and inputs).

**Typography is not configurable.** Managed login exposes spacing, radii
and colours; it has no font-family setting, so the page is rendered in
AWS's own UI face whatever we do. The app's slab display face
(Roboto Slab, via `font-slab` in `tailwind.config.ts`) therefore reaches
the page the only way it can — baked into the wordmark image.

Dark-mode values are filled in from the `.dark` block of `globals.css`
even though `colorSchemeMode` is pinned to `LIGHT`, so that flipping the
scheme later does not drop back to AWS blue.

## Regenerating

```bash
python branding/make-assets.py     # rewrites the .png and the .ico
export AWS_PROFILE=costhub
./do.sh up dev                     # re-applies; converges if already branded
```

`make-assets.py` fetches Roboto Slab Bold (Apache-2.0) into
`branding/.fonts/` on first run and falls back to Georgia Bold — the
family's own fallback in `tailwind.config.ts` — if it cannot. The font
itself is not committed; the drawn PNG is the artifact.

## Limits worth knowing

- The whole create/update request must stay under **2 MB**, assets
  included. These total about 20 KB.
- Accepted extensions are per category: `FAVICON_ICO` takes only `.ico`,
  `IDP_BUTTON_ICON` only `.ico`/`.svg`, the rest `.png`/`.jpeg`/`.svg`.
- An update **preserves settings it is not given**, which is why the
  settings document here is complete rather than a patch: what the file
  says is what the page is.
- `UpdateManagedLoginBranding` does not move a style between app clients.
  If the app client is ever replaced, the new one has no style at all and
  `do.sh` takes the create path.
