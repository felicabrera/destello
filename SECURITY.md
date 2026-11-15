# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use the private vulnerability reporting form of the
repository (Security tab, "Report a vulnerability"). Include the affected URL or component, the steps to
reproduce, and the impact you observed. Do not access data that is not yours and do not run automated scans
that degrade the service.

You can expect an acknowledgement within a few days. Destello is a volunteer project, so fixes are made on a
best effort basis, and confirmed issues are fixed and disclosed once a fix is deployed.

## Scope

The public site `destello.felicabrera.com`, the API under `/api/v1`, and the code in this repository.
Out of scope: the upstream services Destello reads (NASA/IPAC IRSA, Gaia, SIMBAD and others), Cloudflare, and denial of service testing.

## Supported versions

Only the version running at the public URL (the `main` branch) is supported.
