# ArcaneLayer deploy image

This directory is fork-only. It is not part of anything sent upstream, and it
exists to produce one image:

    ghcr.io/queso/dittofeed-lite:v0.23.0-resend-tags

which is `dittofeed/dittofeed-lite:v0.23.0` with the Resend tag encoding fix
(upstream issue #1849) compiled in. The cluster that runs it is `arcane-k8s`,
namespace `dittofeed`, deployment `dittofeed-arcane`.

## Why an overlay instead of a full build

The published `dittofeed-lite` image ships unminified per-file `tsc` output at
`/service/packages/backend-lib/dist/src/`. At the `v0.23.0` tag this tree
reproduces that output byte for byte -- when `backend-lib` is built here, every
compiled file matches the published image's copy exactly, and the image's own
`APP_VERSION` (`fe2b311`) confirms it was built from this commit.

That makes it possible to recompile just `backend-lib` and lay the two patched
modules over the release image, instead of rebuilding the whole monorepo
including the Next.js dashboard for a two-file change.

The reproducibility is what makes the shortcut sound, so
`overlay-lite.Dockerfile` checks it at build time rather than trusting it:

- five untouched modules compiled here must be byte-identical to the base
  image's copies -- if the toolchain ever drifts, the build fails instead of
  quietly shipping a different `backend-lib`
- the two patched modules must *not* be identical -- if they are, the fix did
  not make it into the build
- the emitted `messaging.js` and `resend.js` must both contain
  `encodeResendTags`

## What is patched

Three files on branch `deploy/v0.23.0-resend-tags`:
`packages/backend-lib/src/destinations/resend.ts`,
`packages/backend-lib/src/messaging.ts`, and
`packages/api/src/controllers/webhooksController.ts`.

The first two are a backport of `fix/resend-tag-encoding`, which targets `main`
and is the version to look at for the upstream discussion.

Resend restricts tag names and values to ASCII letters, digits, underscores and
dashes. Dittofeed passes `messageTags` -- which carries `userId` -- straight
through, so any workspace using email addresses as userIds has every Resend
send rejected. Values are encoded on the way out and decoded in
`resendEventToDF` on the way back.

The encoding is identity-preserving: a value already inside Resend's charset
passes through byte for byte, and only out-of-charset values are base64url
encoded behind a `dfb64-` sentinel. That matters twice -- `webhooksController`
reads `tags.workspaceId` off the raw payload before any decoding happens, and
webhooks for messages sent before the patch still decode to themselves, so
there is no migration.

The third is separate. A Resend account fans every event out to every endpoint
configured on it, so instances sharing an account receive each other's events.
`webhooksController` returned 400 for a workspace it did not recognise, which
is a delivery failure from the sender's point of view -- and sustained failures
get the endpoint disabled, silently breaking webhooks for the instance that
*does* own those events. It now acknowledges unknown workspaces with a 200, the
same way it already handled events arriving with no `workspaceId` tag at all. A
workspace that *is* on this instance but has no `webhookKey` still fails loudly,
since that is a real misconfiguration rather than someone else's traffic.

This matters here because `dittofeed-arcane` and `dittofeed-aiteam` share one
Resend account, so each was poisoning the other's endpoint.

## Building

CI does this on every push to the branch
(`.github/workflows/deploy-overlay-image.yaml`), tagging both the floating
`v0.23.0-resend-tags` and an immutable `v0.23.0-resend-tags-<sha>`. Pin the
cluster to the sha tag so ArgoCD sees a manifest change on each rebuild.

Locally:

    docker build -f deploy/overlay-lite.Dockerfile \
      -t ghcr.io/queso/dittofeed-lite:v0.23.0-resend-tags .

## Retiring this

When the upstream fix lands and a release carries it, drop the overlay and
point `arcane-k8s` back at `dittofeed/dittofeed-lite:<that version>`. Nothing
else in the cluster depends on this branch. Because the encoding is
identity-preserving in both directions, switching back and forth does not
strand any in-flight webhooks.
